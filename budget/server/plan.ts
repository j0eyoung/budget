import crypto from 'node:crypto'
import { accrueAndPayMinimums, addMonths, estimateMinimum, payExtra, promoDeadline } from '../shared/payoff.ts'
import type { DebtState } from '../shared/payoff.ts'
import { askClaude } from './claude.ts'
import { db, meta } from './db.ts'
import { debtSummary } from './debts.ts'
import { currentMonth, today } from './queries.ts'
import { normalize } from './recurring.ts'

// The payoff-and-savings plan: an income schedule (paychecks, bonuses,
// raises, side income), planned monthly spending, one-off and monthly
// changes, and goals in order (debts to pay off, then savings to fill). It is
// one JSON document in meta 'plan'. The projection runs month by month from
// today's real balances, so it moves every time the accounts sync.

export type Raise = { month: string; paycheck: number; bonus: number | null }
export const SCHEDULES = ['weekly', 'biweekly', 'semimonthly', 'monthly'] as const
export type Schedule = (typeof SCHEDULES)[number]
export type Income = {
  paycheck: number // net, per paycheck
  schedule: Schedule // biweekly = every 14 days; semimonthly = twice a month
  lastPayday: string // any real payday; weekly and biweekly schedules count from it
  bonus: number // net, per bonus
  bonusMonths: number[] // 1-12
  side: number // other monthly income
  raises: Raise[] // new paycheck (and bonus) from a month on
}
export type PlanEvent = { month: string; label: string; amount: number; monthly: boolean } // amount > 0 = money in
export type GoalItem = { name: string; low: number; high: number; actual: number | null; done: boolean }
export type Goal = { id: string; kind: 'debt' | 'savings'; name: string; accountId: string | null; target: number | null; by: string | null; items: GoalItem[] }
// spending: planned monthly spending excluding loan payments; null = use the actual average.
export type Plan = { income: Income; spending: number | null; events: PlanEvent[]; goals: Goal[] }
export type DebtTerms = { id: string; apr: number | null; promo_apr: number | null; promo_end: string | null; min_payment: number | null }

const DAY = 86400000
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const round = (n: number) => Math.round(n * 100) / 100
const numOr = <T>(v: unknown, fallback: T): number | T => (v === '' || v == null || !Number.isFinite(Number(v)) ? fallback : round(Number(v)))
const monthOrNull = (v: unknown) => (typeof v === 'string' && MONTH_RE.test(v) ? v : null)
const dateOrNull = (v: unknown) => (typeof v === 'string' && DATE_RE.test(v) ? v : null)
const text = (v: unknown, max = 80) => String(v ?? '').trim().slice(0, max)
const list = (v: unknown): any[] => (Array.isArray(v) ? v : [])
const newId = () => crypto.randomUUID().slice(0, 8)
const dayNum = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY)
const fromDayNum = (n: number) => new Date(n * DAY).toISOString().slice(0, 10)
const daysAgo = (n: number) => fromDayNum(dayNum(today()) - n)
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
const monthName = (m: string | null) =>
  m ? new Date(`${m}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'not within 10 years'
const dateName = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

// ---- What the history says about income and spending ----

type Deposit = { date: string; amount: number; label: string }

// Paychecks come from the payer with the most money in over the last 120
// days (at least 3 deposits). Its deposits near the usual amount are
// paychecks; noticeably different ones over $200 are bonuses. Any other payer
// with 2+ deposits in 90 days counts as side income.
function incomeHistory() {
  const rows = db.prepare(`
    SELECT l.date, -l.amount AS amount, COALESCE(l.merchant, l.name) AS label
    FROM ledger l JOIN categories c ON c.id = l.category_id
    WHERE c.kind = 'income' AND l.amount < 0 AND l.pending = 0 AND l.date >= date('now', '-400 days')
    ORDER BY l.date`).all() as Deposit[]
  const groups = new Map<string, Deposit[]>()
  for (const r of rows) {
    const key = normalize(r.label)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(r)
  }
  const since = daysAgo(120)
  let payer = ''
  let best = 0
  for (const [key, deposits] of groups) {
    const recent = deposits.filter((d) => d.date >= since)
    const total = recent.reduce((s, d) => s + d.amount, 0)
    if (recent.length >= 3 && total > best) {
      payer = key
      best = total
    }
  }
  const deposits = groups.get(payer) ?? []
  const usual = deposits.length ? median(deposits.filter((d) => d.date >= since).map((d) => d.amount)) : 0
  const paychecks = deposits.filter((d) => Math.abs(d.amount - usual) <= usual * 0.05)
  const bonuses = deposits.filter((d) => !paychecks.includes(d) && d.amount >= 200)
  let side = 0
  const sideSince = daysAgo(90)
  for (const [key, ds] of groups) {
    const recent = ds.filter((d) => d.date >= sideSince)
    if (key === payer || recent.length < 2) continue
    const days = Math.max(30.44, dayNum(today()) - dayNum(recent[0].date))
    side += (recent.reduce((s, d) => s + d.amount, 0) * 30.44) / days
  }
  return { paychecks, bonuses, side: Math.round(side) }
}

// Every-14-days pay lands exactly 14 days apart (bar the odd holiday);
// twice-a-month pay drifts between 13 and 17 days with the calendar.
function detectSchedule(dates: string[]): Schedule {
  const gaps = dates.slice(1).map((d, i) => dayNum(d) - dayNum(dates[i]))
  if (!gaps.length) return 'biweekly'
  const gap = median(gaps)
  if (gap <= 8) return 'weekly'
  if (gap >= 25) return 'monthly'
  return gaps.filter((g) => g === 14).length >= gaps.length * 0.75 ? 'biweekly' : 'semimonthly'
}

function detectedIncome(h = incomeHistory()): Income {
  const recent = h.paychecks.slice(-8)
  return {
    paycheck: recent.length ? round(median(recent.map((d) => d.amount))) : 0,
    schedule: detectSchedule(recent.map((d) => d.date)),
    lastPayday: recent.at(-1)?.date ?? today(),
    bonus: round(h.bonuses.at(-1)?.amount ?? 0),
    bonusMonths: [...new Set(h.bonuses.map((d) => Number(d.date.slice(5, 7))))].sort((a, b) => a - b),
    side: h.side,
    raises: [],
  }
}

// Average monthly spending over the last three months the history fully
// covers, without loan payments (the plan pays those as debts).
function actualSpending(): number | null {
  const first = (db.prepare('SELECT MIN(date) AS d FROM transactions WHERE pending = 0').get() as { d: string | null }).d
  if (!first) return null
  const months = [1, 2, 3].map((n) => addMonths(currentMonth(), -n)).filter((m) => `${m}-01` >= first)
  if (!months.length) return null
  const row = db.prepare(`
    SELECT COALESCE(SUM(l.amount), 0) AS total FROM ledger l JOIN categories c ON c.id = l.category_id
    WHERE c.kind = 'expense' AND c.name != 'Debt Payments' AND l.pending = 0
      AND substr(l.date, 1, 7) IN (${months.map(() => '?').join(', ')})`).get(...months) as { total: number }
  return Math.round(row.total / months.length)
}

// ---- The plan document ----

export function normalizePlan(input: any): Plan {
  const inc = input?.income ?? {}
  const accountIds = new Set((db.prepare('SELECT id FROM accounts').all() as { id: string }[]).map((a) => a.id))
  const ids = new Set<string>()
  const spending = numOr(input?.spending, null)
  return {
    income: {
      paycheck: Math.max(0, numOr(inc.paycheck, 0)),
      schedule: SCHEDULES.includes(inc.schedule) ? inc.schedule : 'biweekly',
      lastPayday: dateOrNull(inc.lastPayday) ?? detectedIncome().lastPayday,
      bonus: Math.max(0, numOr(inc.bonus, 0)),
      bonusMonths: [...new Set(list(inc.bonusMonths).map(Number).filter((m) => Number.isInteger(m) && m >= 1 && m <= 12))].sort((a, b) => a - b),
      side: Math.max(0, numOr(inc.side, 0)),
      raises: list(inc.raises)
        .map((r) => ({ month: monthOrNull(r?.month), paycheck: Math.max(0, numOr(r?.paycheck, 0)), bonus: numOr(r?.bonus, null) }))
        .filter((r): r is Raise => r.month != null && r.paycheck > 0)
        .sort((a, b) => a.month.localeCompare(b.month))
        .slice(0, 20),
    },
    spending: spending != null && spending > 0 ? spending : null,
    events: list(input?.events)
      .map((e) => ({ month: monthOrNull(e?.month), label: text(e?.label), amount: numOr(e?.amount, 0), monthly: Boolean(e?.monthly) }))
      .filter((e): e is PlanEvent => e.month != null && e.label !== '' && e.amount !== 0)
      .slice(0, 50),
    goals: list(input?.goals).slice(0, 30).map((g): Goal => {
      const kind = g?.kind === 'savings' ? 'savings' : 'debt'
      let id = typeof g?.id === 'string' && /^[\w-]{1,40}$/.test(g.id) ? g.id : newId()
      if (ids.has(id)) id = newId()
      ids.add(id)
      const target = numOr(g?.target, null)
      return {
        id,
        kind,
        name: text(g?.name) || (kind === 'debt' ? 'Pay off debt' : 'Savings goal'),
        accountId: typeof g?.accountId === 'string' && accountIds.has(g.accountId) ? g.accountId : null,
        target: kind === 'savings' && target != null && target > 0 ? target : null,
        by: monthOrNull(g?.by),
        items: kind === 'savings'
          ? list(g?.items).slice(0, 40).map((it) => {
              const low = Math.max(0, numOr(it?.low, 0))
              return { name: text(it?.name), low, high: Math.max(low, numOr(it?.high, 0)), actual: numOr(it?.actual, null), done: Boolean(it?.done) }
            }).filter((it) => it.name)
          : [],
      }
    }),
  }
}

// Until a plan is saved: the detected income, every debt highest rate first,
// and a 6-month emergency fund on the savings account if there is one.
function defaultPlan(): Plan {
  const debts = debtSummary().filter((d) => d.in_plan).sort((a, b) => (b.apr ?? 0) - (a.apr ?? 0) || a.owed - b.owed)
  const goals: Goal[] = debts.map((d) => ({ id: `debt-${d.id.replace(/[^\w-]/g, '').slice(-24)}`, kind: 'debt', name: `Pay off ${d.org_name || d.name}`, accountId: d.id, target: null, by: null, items: [] }))
  const savings = db.prepare(`SELECT id FROM accounts WHERE type = 'depository' AND name LIKE '%saving%' ORDER BY balance DESC LIMIT 1`).get() as { id: string } | undefined
  const spending = actualSpending()
  if (savings && spending) {
    goals.push({ id: 'emergency-fund', kind: 'savings', name: 'Emergency fund (6 months)', accountId: savings.id, target: Math.round((spending * 6) / 100) * 100, by: null, items: [] })
  }
  return { income: detectedIncome(), spending: null, events: [], goals }
}

export function loadPlan(): { plan: Plan; saved: boolean } {
  const raw = meta.get('plan')
  if (raw) {
    try {
      return { plan: normalizePlan(JSON.parse(raw)), saved: true }
    } catch {
      // fall through to the default
    }
  }
  return { plan: defaultPlan(), saved: false }
}

export function savePlan(input: unknown): void {
  meta.set('plan', JSON.stringify(normalizePlan(input)))
}

export function resetPlan(): void {
  meta.delete('plan')
}

// Account ids of the saved plan's debt goals, in payoff order (for the Debt tab).
export function planDebtOrder(): string[] {
  const { plan, saved } = loadPlan()
  return saved ? plan.goals.filter((g) => g.kind === 'debt' && g.accountId).map((g) => g.accountId!) : []
}

// ---- Projection ----

// How many paychecks land in a month.
function paychecksIn(inc: Income, month: string): number {
  if (inc.schedule === 'semimonthly') return 2
  if (inc.schedule === 'monthly') return 1
  const step = inc.schedule === 'weekly' ? 7 : 14
  const start = dayNum(`${month}-01`)
  const end = dayNum(`${addMonths(month, 1)}-01`) - 1
  const anchor = dayNum(inc.lastPayday)
  const first = anchor + Math.ceil((start - anchor) / step) * step
  return first > end ? 0 : Math.floor((end - first) / step) + 1
}

const paycheckAt = (inc: Income, month: string) => inc.raises.filter((r) => r.month <= month).at(-1)?.paycheck ?? inc.paycheck
const bonusAt = (inc: Income, month: string) => inc.raises.filter((r) => r.month <= month && r.bonus != null).at(-1)?.bonus ?? inc.bonus

// The month's paychecks (minus `received` already in, for the current month)
// plus a bonus in bonus months.
function scheduledPay(inc: Income, month: string, received: number, bonusPaid: boolean): { amount: number; notes: string[] } {
  const count = paychecksIn(inc, month)
  const notes: string[] = []
  if (count >= 3 && inc.schedule === 'biweekly') notes.push('3 paychecks')
  if (inc.raises.some((r) => r.month === month)) notes.push('raise')
  let amount = Math.max(0, count - received) * paycheckAt(inc, month)
  const bonus = bonusAt(inc, month)
  if (bonus > 0 && inc.bonusMonths.includes(Number(month.slice(5))) && !bonusPaid) {
    amount += bonus
    notes.push('bonus')
  }
  return { amount, notes }
}

const eventsIn = (plan: Plan, month: string, part: number) =>
  plan.events.reduce((s, e) => s + (e.monthly ? (e.month <= month ? e.amount * part : 0) : e.month === month ? e.amount : 0), 0)

type PlanDebt = DebtState & { label: string; short: string; aprMissing: boolean; minEstimated: boolean }
type SavingsState = { id: string; name: string; target: number | null; saved: number }
type PlanState = { debts: PlanDebt[]; savings: SavingsState[] }

function planState(plan: Plan): PlanState {
  const date = today()
  const debtGoals = plan.goals.filter((g) => g.kind === 'debt' && g.accountId)
  const order = debtGoals.map((g) => g.accountId!)
  const goalName = new Map(debtGoals.map((g) => [g.accountId!, g.name]))
  const debts: PlanDebt[] = debtSummary()
    .filter((d) => d.in_plan || order.includes(d.id))
    .map((d) => {
      const promo = Boolean(d.promo_end && d.promo_end > date)
      const min = estimateMinimum({ ...d, apr: promo ? (d.promo_apr ?? 0) : d.apr })
      const short = d.org_name || d.name
      return {
        id: d.id, name: d.name, short, label: goalName.get(d.id) ?? short, type: d.type, balance: d.owed,
        apr: d.apr ?? 0, aprMissing: d.apr == null, promoApr: d.promo_apr, promoEnd: d.promo_end,
        min: min.value, minEstimated: min.estimated,
      }
    })
  // Payoff order: the plan's debt goals in order, then anything else highest rate first.
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length)
  debts.sort((a, b) => rank(a.id) - rank(b.id) || b.apr - a.apr || a.balance - b.balance)
  // Savings goals stack on their account: the first goal on an account counts
  // its balance up to its target, the next goal the rest, and so on.
  const left = new Map((db.prepare('SELECT id, balance FROM accounts WHERE balance > 0').all() as { id: string; balance: number }[]).map((a) => [a.id, a.balance]))
  const savings = plan.goals.filter((g) => g.kind === 'savings').map((g) => {
    const available = g.accountId ? left.get(g.accountId) ?? 0 : 0
    const saved = g.target == null ? available : Math.min(available, g.target)
    if (g.accountId) left.set(g.accountId, available - saved)
    return { id: g.id, name: g.name, target: g.target, saved }
  })
  return { debts, savings }
}

export type MonthRow = {
  month: string
  income: number
  spending: number
  minimums: number
  interest: number
  toDebt: number
  toSavings: number
  drawn: number
  borrowed: number
  debtLeft: number
  saved: number
  spare: number
  notes: string[]
}
type Projection = { rows: MonthRow[]; paidOff: Record<string, string>; reached: Record<string, string>; debtFree: string | null }
type Context = { date: string; received: number; bonusPaid: boolean } // received: paychecks already in this month

// Month by month from today (the rest of this month counts pro rata): income
// minus spending minus minimums is what's left. It goes to the debts in plan
// order, then fills savings goals in order; whatever is left after every goal
// is spare. A short month is covered from spare cash, then savings (last goal
// first), then a credit card.
function project(plan: Plan, state: PlanState, ctx: Context, spending: number, extra = 0, horizon = 120): Projection {
  const m0 = ctx.date.slice(0, 7)
  const [y, m, d] = ctx.date.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const firstPart = (daysInMonth - d + 1) / daysInMonth
  const debts = state.debts.map((x) => ({ ...x }))
  const goals = state.savings.map((x) => ({ ...x }))
  const paidOff: Record<string, string> = {}
  const reached: Record<string, string> = {}
  let debtFree: string | null = debts.length ? null : m0
  let spare = 0
  const rows: MonthRow[] = []
  for (let k = 0; k < horizon; k++) {
    const month = addMonths(m0, k)
    const part = k === 0 ? firstPart : 1
    const pay = scheduledPay(plan.income, month, k === 0 ? ctx.received : 0, k === 0 && ctx.bonusPaid)
    const notes = [...pay.notes, ...plan.events.filter((e) => e.month === month).map((e) => e.label)]
    const income = pay.amount + (plan.income.side + extra) * part + eventsIn(plan, month, part)
    const spent = spending * part
    const { interest, paid: minimums } = accrueAndPayMinimums(debts, month, part)
    const cash = income - spent - minimums
    let toDebt = 0
    let toSavings = 0
    let drawn = 0
    let borrowed = 0
    if (cash >= 0) {
      let left = payExtra(debts, cash)
      toDebt = cash - left
      for (const g of goals) {
        if (left <= 0) break
        const put = Math.min(left, g.target == null ? left : Math.max(0, g.target - g.saved))
        g.saved += put
        left -= put
        toSavings += put
      }
      spare += left
    } else {
      let need = -cash
      const take = (available: number) => {
        const t = Math.max(0, Math.min(available, need))
        need -= t
        drawn += t
        return t
      }
      spare -= take(spare)
      for (const g of [...goals].reverse()) g.saved -= take(g.saved)
      if (need > 0) {
        borrowed = need
        const card = debts.find((x) => x.type === 'credit') ?? debts[0]
        if (card) card.balance += need
      }
    }
    for (const x of debts) {
      if (x.balance > 0.005) {
        delete paidOff[x.id]
        continue
      }
      x.balance = 0
      if (!paidOff[x.id]) {
        paidOff[x.id] = month
        notes.push(`✓ ${x.label}`)
      }
    }
    for (const g of goals) {
      if (g.target == null) continue
      if (g.saved < g.target - 0.005) {
        delete reached[g.id]
        continue
      }
      if (!reached[g.id]) {
        reached[g.id] = month
        if (k > 0) notes.push(`✓ ${g.name}`)
      }
    }
    if (debts.some((x) => x.balance > 0)) debtFree = null
    else debtFree ??= month
    const r = Math.round
    rows.push({
      month, income: r(income), spending: r(spent), minimums: r(minimums), interest: r(interest), toDebt: r(toDebt),
      toSavings: r(toSavings), drawn: r(drawn), borrowed: r(borrowed),
      debtLeft: r(debts.reduce((s, x) => s + x.balance, 0)), saved: r(goals.reduce((s, g) => s + g.saved, 0)), spare: r(spare), notes,
    })
  }
  return { rows, paidOff, reached, debtFree }
}

// ---- Report ----

export type GoalStatus = 'done' | 'on track' | 'behind' | 'no date' | 'not reachable' | 'no account'

export function planReport() {
  const { plan, saved } = loadPlan()
  const date = today()
  const month = date.slice(0, 7)
  const state = planState(plan)
  const history = incomeHistory()
  const ctx: Context = {
    date,
    received: history.paychecks.filter((d) => d.date.startsWith(month)).length,
    bonusPaid: history.bonuses.some((d) => d.date.startsWith(month)),
  }
  const actual = actualSpending()
  const spending = plan.spending ?? actual ?? 0
  const run = (extra = 0, s = spending) => project(plan, state, ctx, s, extra)
  const base = run()
  const atActual = plan.spending != null && actual != null && Math.abs(actual - plan.spending) >= 50 ? run(0, actual) : null

  // Smallest change in monthly cash that still meets the test: positive =
  // needed on top of the plan, negative = could be spared. null = not even
  // with $15k/mo more.
  const needed = (meets: (p: Projection) => boolean): number | null => {
    let lo = -5000
    let hi = 15000
    if (!meets(run(hi))) return null
    if (meets(run(lo))) return lo
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2
      if (meets(run(mid))) hi = mid
      else lo = mid
    }
    return Math.ceil(hi / 10) * 10
  }
  const reachedIn = (g: Goal, p: Projection): string | null =>
    g.kind === 'debt' ? (g.accountId ? p.paidOff[g.accountId] ?? null : null) : p.reached[g.id] ?? null

  const accounts = db.prepare('SELECT id, name, org_name, type, balance FROM accounts ORDER BY type, org_name, name').all() as
    { id: string; name: string; org_name: string | null; type: string; balance: number }[]
  const accountName = new Map(accounts.map((a) => [a.id, a.name]))
  const debtById = new Map(state.debts.map((d) => [d.id, d]))
  const savingsById = new Map(state.savings.map((s) => [s.id, s]))

  const goals = plan.goals.map((g) => {
    const debt = g.accountId ? debtById.get(g.accountId) : undefined
    const now = g.kind === 'debt' ? debt?.balance ?? 0 : savingsById.get(g.id)?.saved ?? 0
    const done = g.kind === 'debt' ? Boolean(g.accountId) && !debt : g.target != null && now >= g.target
    const projected = done ? month : reachedIn(g, base)
    let status: GoalStatus
    let perMonth: number | null = null
    if (done) status = 'done'
    else if (!g.accountId && g.kind === 'debt') status = 'no account'
    else if (!g.by) status = projected ? 'no date' : 'not reachable'
    else {
      const by = g.by
      perMonth = needed((p) => (reachedIn(g, p) ?? '9999-12') <= by)
      status = perMonth == null ? 'not reachable' : perMonth <= 0 ? 'on track' : 'behind'
    }
    const cost = g.items.length
      ? {
          low: g.items.reduce((s, i) => s + i.low, 0),
          high: g.items.reduce((s, i) => s + i.high, 0),
          actual: g.items.reduce((s, i) => s + (i.actual ?? 0), 0),
          done: g.items.filter((i) => i.done).length,
        }
      : null
    return {
      ...g, account: g.accountId ? accountName.get(g.accountId) ?? null : null, now: round(now), projected,
      atActual: atActual ? (done ? month : reachedIn(g, atActual)) : undefined, status, perMonth, cost,
    }
  })

  const promos = state.debts.filter((d) => d.promoEnd && d.promoEnd > date).map((d) => {
    const deadline = promoDeadline(d.promoEnd!)
    const projected = base.paidOff[d.id] ?? null
    const ok = projected != null && projected <= deadline
    return {
      id: d.id, name: d.label, promoApr: d.promoApr ?? 0, promoEnd: d.promoEnd!, deadline, projected, ok,
      perMonth: ok ? null : needed((p) => (p.paidOff[d.id] ?? '9999-12') <= deadline),
    }
  })

  // The card being paid off right now, and what's still being put on it.
  const focusDebt = state.debts[0]
  const charges = focusDebt
    ? (db.prepare(`
        SELECT l.date, COALESCE(l.merchant, l.name) AS merchant, l.amount
        FROM ledger l JOIN categories c ON c.id = l.category_id
        WHERE l.account_id = ? AND c.kind = 'expense' AND l.amount > 0 AND substr(l.date, 1, 7) = ?
        ORDER BY l.date DESC, l.amount DESC`).all(focusDebt.id, month) as { date: string; merchant: string; amount: number }[])
    : []
  const focus = focusDebt
    ? {
        accountId: focusDebt.id, name: focusDebt.short, goal: focusDebt.label, type: focusDebt.type, owed: round(focusDebt.balance),
        chargesThisMonth: round(charges.reduce((s, c) => s + c.amount, 0)), count: charges.length, recent: charges.slice(0, 8),
      }
    : null

  // A bonus or a third paycheck in the last 3 days, and where the plan sends it.
  const recentSince = daysAgo(3)
  const nextGoal = goals.find((g) => g.status !== 'done')
  const windfalls = [
    ...history.bonuses.filter((d) => d.date >= recentSince).map((d) => ({ date: d.date, amount: d.amount, kind: 'bonus' })),
    ...history.paychecks
      .filter((d, _i, all) => d.date >= recentSince && all.filter((x) => x.date.slice(0, 7) === d.date.slice(0, 7) && x.date <= d.date).length === 3)
      .map((d) => ({ date: d.date, amount: d.amount, kind: 'third paycheck' })),
  ].map((w) => ({ ...w, sendTo: nextGoal?.name ?? null }))

  const warnings: string[] = []
  for (const p of promos) {
    if (p.ok) continue
    warnings.push(`${p.name}: the ${p.promoApr}% rate ends ${dateName(p.promoEnd)}, but at this pace it's paid off ${p.projected ? monthName(p.projected) : 'not within 10 years'}.${p.perMonth != null ? ` It needs about ${usd(p.perMonth)}/mo more to be gone by ${monthName(p.deadline)}.` : ''}`)
  }
  for (const g of goals) {
    if (g.status === 'behind') warnings.push(`${g.name}: projected ${monthName(g.projected)}, target ${monthName(g.by)}. Needs about ${usd(g.perMonth!)}/mo more.`)
    if (g.status === 'not reachable' && g.by) warnings.push(`${g.name}: can't be reached by ${monthName(g.by)} at any realistic pace.`)
  }
  if (atActual && actual != null && actual > spending) {
    warnings.push(`Actual spending averages ${usd(actual)}/mo, ${usd(actual - spending)} over the plan's ${usd(spending)}. At that rate you're debt-free ${monthName(atActual.debtFree)} instead of ${monthName(base.debtFree)}.`)
  }
  const shortMonths = base.rows.slice(1, 13).filter((r) => r.borrowed > 0)
  if (shortMonths.length) {
    warnings.push(`At ${usd(spending)}/mo spending, income doesn't cover spending plus minimum payments in ${shortMonths.length} of the next 12 months (about ${usd(shortMonths.reduce((s, r) => s + r.borrowed, 0) / shortMonths.length)} short each); the plan assumes that goes on a card.`)
  }
  if (focus && focus.type === 'credit' && focus.count) {
    warnings.push(`${usd(focus.chargesThisMonth)} of new charges on ${focus.name} this month (${focus.count}), the card you're paying off.`)
  }
  const noApr = state.debts.filter((d) => d.aprMissing)
  if (noApr.length) warnings.push(`No APR entered for ${noApr.map((d) => d.short).join(', ')}; counted as 0% (after any promo), so dates are optimistic. Add it in the Debt tab.`)

  // Show the months up to the last milestone, plus a little after.
  const lastMilestone = [base.debtFree, ...goals.map((g) => g.projected)].reduce<string | null>((a, b) => (b && (!a || b > a) ? b : a), null)
  const span = lastMilestone ? (Number(lastMilestone.slice(0, 4)) - Number(month.slice(0, 4))) * 12 + Number(lastMilestone.slice(5)) - Number(month.slice(5)) + 3 : 60
  const debtTerms = debtSummary().map((d) => {
    const promo = Boolean(d.promo_end && d.promo_end > date)
    return {
      id: d.id, name: d.name, org_name: d.org_name, owed: d.owed, apr: d.apr, promo_apr: d.promo_apr, promo_end: d.promo_end,
      min_payment: d.min_payment, min_estimate: estimateMinimum({ ...d, apr: promo ? (d.promo_apr ?? 0) : d.apr }).value, in_plan: d.in_plan,
    }
  })

  return {
    saved,
    plan,
    detected: { income: detectedIncome(history), spending: actual },
    spending: { planned: spending, actual, usingActual: plan.spending == null },
    accounts,
    debtTerms,
    goals,
    promos,
    focus,
    windfalls,
    warnings,
    debtFree: { plan: base.debtFree, actual: atActual ? atActual.debtFree : undefined },
    months: base.rows.slice(0, Math.min(120, Math.max(12, span))),
    actual: planVsActual(plan, spending, state.debts.map((d) => d.id)),
  }
}

// Plan vs what happened, for recent months the history fully covers and this
// month so far. "Left" is income minus spending: what was available for debt
// payments and savings. Debt paid is payments minus new charges on the plan's debts.
function planVsActual(plan: Plan, spending: number, debtIds: string[]) {
  const first = (db.prepare('SELECT MIN(date) AS d FROM transactions WHERE pending = 0').get() as { d: string | null }).d
  if (!first) return []
  const month = currentMonth()
  const months = [5, 4, 3, 2, 1, 0].map((n) => addMonths(month, -n)).filter((m) => `${m}-01` >= first || m === month)
  const flows = new Map((db.prepare(`
    SELECT substr(l.date, 1, 7) AS month,
      -SUM(CASE WHEN c.kind = 'income' THEN l.amount ELSE 0 END) AS income,
      SUM(CASE WHEN c.kind = 'expense' AND c.name != 'Debt Payments' THEN l.amount ELSE 0 END) AS spending
    FROM ledger l JOIN categories c ON c.id = l.category_id
    WHERE l.pending = 0 AND substr(l.date, 1, 7) >= ? GROUP BY 1`).all(months[0]) as { month: string; income: number; spending: number }[]).map((f) => [f.month, f]))
  const paid = new Map(debtIds.length
    ? (db.prepare(`
        SELECT substr(date, 1, 7) AS month, -SUM(amount) AS paid FROM ledger
        WHERE pending = 0 AND account_id IN (${debtIds.map(() => '?').join(', ')}) AND substr(date, 1, 7) >= ? GROUP BY 1`)
        .all(...debtIds, months[0]) as { month: string; paid: number }[]).map((p) => [p.month, p.paid])
    : [])
  const r = Math.round
  return months.map((m) => {
    const f = flows.get(m) ?? { income: 0, spending: 0 }
    const planIncome = scheduledPay(plan.income, m, 0, false).amount + plan.income.side + eventsIn(plan, m, 1)
    return {
      month: m,
      partial: m === month,
      income: { plan: r(planIncome), actual: r(f.income) },
      spending: { plan: r(spending), actual: r(f.spending) },
      left: { plan: r(planIncome - spending), actual: r(f.income - f.spending) },
      debtPaid: paid.has(m) ? r(paid.get(m)!) : null,
    }
  })
}

// Compact version for the daily briefing and /api/summary; a failure here
// must not take those down, so it logs and returns null.
export function planBrief() {
  try {
    const r = planReport()
    const recent = daysAgo(3)
    return {
      debtFree: r.debtFree.plan,
      next: r.goals.filter((g) => g.status !== 'done').slice(0, 3).map((g) => ({ name: g.name, projected: g.projected, by: g.by, status: g.status, perMonth: g.perMonth })),
      focus: r.focus ? { name: r.focus.name, owed: r.focus.owed, chargesThisMonth: r.focus.chargesThisMonth, recentCharges: r.focus.recent.filter((c) => c.date >= recent) } : null,
      windfalls: r.windfalls,
      warnings: r.warnings,
    }
  } catch (err: any) {
    console.error('Plan summary failed:', err.message)
    return null
  }
}

// ---- Import a written plan through Claude ----

export async function importPlan(raw: string): Promise<{ plan: Plan; debts: DebtTerms[] }> {
  const body = raw.trim().slice(0, 40000)
  if (body.length < 40) throw new Error('Paste the written plan first.')
  const accounts = db.prepare(`SELECT id, name, org_name AS institution, type, ROUND(balance, 2) AS balance FROM accounts ORDER BY type, name`).all() as { id: string }[]
  const reply = await askClaude(`Turn this written personal financial plan into settings for a budgeting app. Reply with only JSON in this shape, no other text:
{"income": {"paycheck": <net amount per paycheck now>, "bonus": <net amount per bonus now, 0 if none>, "bonusMonths": [<month numbers 1-12 when bonuses are paid>], "side": <other regular monthly income such as a side job>,
  "raises": [{"month": "YYYY-MM", "paycheck": <new net per-paycheck amount>, "bonus": <new per-bonus amount or null>}]},
 "spending": <planned monthly spending on everything except loan and credit card payments (housing, utilities, insurance, food, gas...), or null>,
 "events": [{"month": "YYYY-MM", "label": "<short>", "amount": <money in positive, money out negative>, "monthly": <true if it repeats every month from then on>}],
 "goals": [{"kind": "debt" or "savings", "name": "<short>", "accountId": "<id from the account list, or null>", "target": <savings target amount or null>, "by": "YYYY-MM" or null,
   "items": [{"name": "<cost line item>", "low": <number>, "high": <number>}]}],
 "debts": [{"accountId": "<id>", "apr": <regular APR percent or null>, "promoApr": <promotional APR percent or null>, "promoEnd": "YYYY-MM-DD" or null, "min": <required monthly payment or null>}]}
Rules:
- goals are in the order the plan works on them: the debts to pay off in the plan's order, then the savings goals in order. A debt goal's accountId is the matching debt account. Savings goals use the savings account the plan names; several goals may share one account (they fill in order).
- items only for savings goals that are projects with cost estimates (a renovation, a build); otherwise [].
- events are things that change cash flow from a given month: a one-off purchase (negative), a cancelled subscription (positive, monthly), new rent coming in (positive, monthly). Bonuses and raises belong in income, not events. Debt payoffs are not events.
- "debts" lists each debt account the plan gives terms for.
- Use null where the plan doesn't say. Don't invent numbers.
Today is ${today()}.

Accounts:
${JSON.stringify(accounts)}

Plan:
"""
${body}
"""`)
  const cleaned = reply.replace(/```(?:json)?/g, '').trim()
  let parsed: any
  try {
    parsed = JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1))
  } catch {
    throw new Error("Couldn't read Claude's answer. Try again.")
  }
  // Anything the text didn't cover keeps its current value.
  const current = loadPlan().plan
  const inc = parsed.income ?? {}
  const pick = <T>(v: T | null | undefined, fallback: T): T => (v == null ? fallback : v)
  const plan = normalizePlan({
    income: {
      paycheck: pick(inc.paycheck, current.income.paycheck),
      // How often pay actually lands is known from the deposits; a written plan can be wrong about it.
      schedule: current.income.schedule,
      lastPayday: current.income.lastPayday,
      bonus: pick(inc.bonus, current.income.bonus),
      bonusMonths: list(inc.bonusMonths).length ? inc.bonusMonths : current.income.bonusMonths,
      side: pick(inc.side, current.income.side),
      raises: Array.isArray(inc.raises) ? inc.raises : current.income.raises,
    },
    spending: pick(parsed.spending, current.spending),
    events: Array.isArray(parsed.events) ? parsed.events : current.events,
    goals: list(parsed.goals).length ? parsed.goals : current.goals,
  })
  const ids = new Set(accounts.map((a) => a.id))
  const debts = list(parsed.debts)
    .filter((d) => ids.has(d?.accountId))
    .map((d) => ({ id: d.accountId as string, apr: numOr(d.apr, null), promo_apr: numOr(d.promoApr, null), promo_end: dateOrNull(d.promoEnd), min_payment: numOr(d.min, null) }))
  return { plan, debts }
}
