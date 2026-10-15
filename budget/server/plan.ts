import crypto from 'node:crypto'
import { addMonths, estimateMinimum, promoDeadline } from '../shared/payoff.ts'
import {
  SCHEDULES, deadlineGoals, eventsIn, goalDeadline, goalDone, goalMonth, maxSpending, meetsDeadline, project, scheduledPay,
} from '../shared/plan-math.ts'
import type { Context, Goal, Income, Plan, PlanDebt, PlanEvent, PlanState, Raise, Schedule } from '../shared/plan-math.ts'
import { askClaude } from './claude.ts'
import { db, meta } from './db.ts'
import { debtSummary } from './debts.ts'
import { currentMonth, historyStart, today } from './queries.ts'
import { normalize } from './recurring.ts'

// The payoff-and-savings plan: an income schedule (paychecks, bonuses,
// raises, side income), planned monthly spending, one-off and monthly
// changes, and goals in order (debts to pay off, then savings to fill). It is
// one JSON document in meta 'plan'. The projection (shared/plan-math.ts) runs
// month by month from today's real balances, so it moves with every sync.

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

// What spending (without loan payments, which the plan pays as debts) has
// actually been: the last full month, and the average of the last three
// months the history fully covers.
function spendingHistory(): { average: number | null; lastMonth: { month: string; amount: number } | null } {
  const first = historyStart()
  const months = first ? [1, 2, 3].map((n) => addMonths(currentMonth(), -n)).filter((m) => `${m}-01` >= first) : []
  if (!months.length) return { average: null, lastMonth: null }
  const totals = new Map((db.prepare(`
    SELECT substr(l.date, 1, 7) AS month, SUM(l.amount) AS total FROM ledger l JOIN categories c ON c.id = l.category_id
    WHERE c.kind = 'expense' AND c.name != 'Debt Payments' AND l.pending = 0
      AND substr(l.date, 1, 7) IN (${months.map(() => '?').join(', ')})
    GROUP BY 1`).all(...months) as { month: string; total: number }[]).map((r) => [r.month, r.total]))
  const sum = months.reduce((s, m) => s + (totals.get(m) ?? 0), 0)
  return { average: Math.round(sum / months.length), lastMonth: { month: months[0], amount: Math.round(totals.get(months[0]) ?? 0) } }
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
  const spending = spendingHistory().average
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

// ---- Projection inputs ----

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
  const spent = spendingHistory()
  const spending = plan.spending ?? spent.average ?? 0
  const base = project(plan, state, ctx, spending)

  // The most that can be spent each month while still making every
  // deadline (target dates, and promo end dates), and each one on its own.
  const deadlines = deadlineGoals(plan, state, date)
  const ceiling = deadlines.length ? maxSpending(plan, state, ctx, (p) => deadlines.every((d) => meetsDeadline(d.goal, d.deadline)(p))) : null
  const limits = new Map(deadlines.map((d) => [d.goal.id, maxSpending(plan, state, ctx, meetsDeadline(d.goal, d.deadline))]))

  const accounts = db.prepare('SELECT id, name, org_name, type, balance FROM accounts ORDER BY type, org_name, name').all() as
    { id: string; name: string; org_name: string | null; type: string; balance: number }[]
  const accountName = new Map(accounts.map((a) => [a.id, a.name]))
  const debtById = new Map(state.debts.map((d) => [d.id, d]))
  const savingsById = new Map(state.savings.map((s) => [s.id, s]))

  const goals = plan.goals.map((g) => {
    const now = g.kind === 'debt' ? (g.accountId ? debtById.get(g.accountId)?.balance ?? 0 : 0) : savingsById.get(g.id)?.saved ?? 0
    const done = goalDone(g, state)
    const deadline = done ? null : goalDeadline(g, state, date)
    const projected = done ? month : goalMonth(g, base)
    const limit = limits.get(g.id) ?? null
    let status: GoalStatus
    if (done) status = 'done'
    else if (g.kind === 'debt' && !g.accountId) status = 'no account'
    else if (!deadline) status = projected ? 'no date' : 'not reachable'
    else status = limit == null ? 'not reachable' : spending <= limit ? 'on track' : 'behind'
    // How much less would have to be spent each month to make it (negative = room to spare).
    const perMonth = deadline && limit != null ? Math.round(spending - limit) : null
    const cost = g.items.length
      ? {
          low: g.items.reduce((s, i) => s + i.low, 0),
          high: g.items.reduce((s, i) => s + i.high, 0),
          actual: g.items.reduce((s, i) => s + (i.actual ?? 0), 0),
          done: g.items.filter((i) => i.done).length,
        }
      : null
    return { ...g, account: g.accountId ? accountName.get(g.accountId) ?? null : null, now: round(now), deadline, projected, status, perMonth, limit, cost }
  })

  const promos = state.debts.filter((d) => d.promoEnd && d.promoEnd > date).map((d) => {
    const deadline = promoDeadline(d.promoEnd!)
    const projected = base.paidOff[d.id] ?? null
    return { id: d.id, name: d.label, short: d.short, promoApr: d.promoApr ?? 0, promoEnd: d.promoEnd!, deadline, projected, ok: projected != null && projected <= deadline }
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

  // For the daily briefing and the dashboard.
  const warnings: string[] = []
  const last = spent.lastMonth ? ` ${monthName(spent.lastMonth.month).split(' ')[0]} was ${usd(spent.lastMonth.amount)}.` : ''
  if (deadlines.length && ceiling == null) warnings.push('Some target dates are too soon to make even with no spending at all; move them later.')
  else if (ceiling != null && spending > ceiling) warnings.push(`To make every payoff date, spending has to stay under ${usd(ceiling)}/mo; the plan uses ${usd(spending)}.${last}`)
  for (const p of promos) {
    if (p.ok) continue
    const goal = goals.find((g) => g.kind === 'debt' && g.accountId === p.id)
    const limit = goal?.limit ?? maxSpending(plan, state, ctx, (x) => (x.paidOff[p.id] ?? '9999-12') <= p.deadline)
    warnings.push(`${p.short}: the ${p.promoApr}% rate ends ${dateName(p.promoEnd)}. ${limit != null ? `Clearing it in time means spending under ${usd(limit)}/mo.` : "It can't be cleared in time at any spending level."}`)
  }
  if (focus && focus.type === 'credit' && focus.count) {
    warnings.push(`${usd(focus.chargesThisMonth)} of new charges on ${focus.name} this month (${focus.count}), the card you're paying off.`)
  }
  const noApr = state.debts.filter((d) => d.aprMissing)
  if (noApr.length) warnings.push(`No APR entered for ${noApr.map((d) => d.short).join(', ')}; counted as 0% (after any promo), so dates are optimistic. Add it in the Debt tab.`)

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
    detected: { income: detectedIncome(history), spending: spent.average },
    spending: { planned: spending, actual: spent.average, lastMonth: spent.lastMonth, usingActual: plan.spending == null },
    ceiling,
    debtFree: base.debtFree,
    accounts,
    debtTerms,
    goals,
    promos,
    focus,
    windfalls,
    warnings,
    // Inputs for the browser to rerun the projection as the spending slider moves.
    model: { state, ctx },
    actual: planVsActual(plan, spending, state.debts.map((d) => d.id)),
  }
}
// Plan vs what happened, for recent months the history fully covers and this
// month so far. "Left" is income minus spending: what was available for debt
// payments and savings. Debt paid is payments minus new charges on the plan's debts.
function planVsActual(plan: Plan, spending: number, debtIds: string[]) {
  const first = historyStart()
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
      debtFree: r.debtFree,
      spendingLimit: r.ceiling,
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
