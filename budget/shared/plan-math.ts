// The Plan's month-by-month projection, shared by the server (Plan report,
// daily briefing) and the browser (the spending slider recomputes it live).
// Pure: everything it needs comes in as arguments.
import { accrueAndPayMinimums, addMonths, payExtra, promoDeadline } from './payoff.ts'
import type { DebtState } from './payoff.ts'

export const SCHEDULES = ['weekly', 'biweekly', 'semimonthly', 'monthly'] as const
export type Schedule = (typeof SCHEDULES)[number]
export type Raise = { month: string; paycheck: number }
export type Bonus = { month: number; amount: number } // month of the year 1-12, net amount
export type Income = {
  paycheck: number // net, per paycheck
  schedule: Schedule // biweekly = every 14 days; semimonthly = twice a month
  lastPayday: string // any real payday; weekly and biweekly schedules count from it
  bonuses: Bonus[] // at today's pay; they grow with raises
  side: number // other monthly income
  raises: Raise[] // new paycheck from a month on
}
export type PlanEvent = { month: string; label: string; amount: number; monthly: boolean } // amount > 0 = money in
export type GoalItem = { name: string; low: number; high: number; actual: number | null; done: boolean }
export type Goal = { id: string; kind: 'debt' | 'savings'; name: string; accountId: string | null; target: number | null; by: string | null; items: GoalItem[] }
// spending: planned monthly spending excluding loan payments; null = use the actual average.
export type Plan = { income: Income; spending: number | null; events: PlanEvent[]; goals: Goal[] }

export type PlanDebt = DebtState & { label: string; short: string; aprMissing: boolean; minEstimated: boolean }
export type SavingsState = { id: string; name: string; target: number | null; saved: number }
// Debts in payoff order and savings goals with what they hold today.
export type PlanState = { debts: PlanDebt[]; savings: SavingsState[] }
// date: today; received: paychecks already in this month; bonusPaid: this month's bonus already in.
export type Context = { date: string; received: number; bonusPaid: boolean }

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
export type Projection = { rows: MonthRow[]; paidOff: Record<string, string>; reached: Record<string, string>; debtFree: string | null }

const DAY = 86400000
const dayNum = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY)

export const monthsBetween = (from: string, to: string) =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7))

// How many paychecks land in a month.
export function paychecksIn(inc: Income, month: string): number {
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

// That month's bonus, grown by the same share as any raise before it (6% more
// pay, 6% bigger bonus).
export function bonusIn(inc: Income, month: string): number {
  const bonus = inc.bonuses.find((b) => b.month === Number(month.slice(5)))
  if (!bonus) return 0
  return inc.paycheck > 0 ? (bonus.amount * paycheckAt(inc, month)) / inc.paycheck : bonus.amount
}

// The month's paychecks (minus `received` already in, for the current month)
// plus its bonus, if it has one and it isn't in yet.
export function scheduledPay(inc: Income, month: string, received: number, bonusPaid: boolean): { amount: number; notes: string[] } {
  const count = paychecksIn(inc, month)
  const notes: string[] = []
  if (count >= 3 && inc.schedule === 'biweekly') notes.push('3 paychecks')
  if (inc.raises.some((r) => r.month === month)) notes.push('raise')
  let amount = Math.max(0, count - received) * paycheckAt(inc, month)
  const bonus = bonusIn(inc, month)
  if (bonus > 0 && !bonusPaid) {
    amount += bonus
    notes.push('bonus')
  }
  return { amount, notes }
}

export const eventsIn = (plan: Plan, month: string, part: number) =>
  plan.events.reduce((s, e) => s + (e.monthly ? (e.month <= month ? e.amount * part : 0) : e.month === month ? e.amount : 0), 0)

// Month by month from today (the rest of this month counts pro rata): income
// minus spending minus minimums is what's left. It goes to the debts in plan
// order, then fills savings goals in order; whatever is left after every goal
// is spare. A short month is covered from spare cash, then savings (last goal
// first), then a credit card, so at too-high spending the card balances grow.
export function project(plan: Plan, state: PlanState, ctx: Context, spending: number, horizon = 120): Projection {
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
    const income = pay.amount + plan.income.side * part + eventsIn(plan, month, part)
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

// Already done today: the debt is gone, or the savings goal is full.
export function goalDone(g: Goal, state: PlanState): boolean {
  if (g.kind === 'debt') return Boolean(g.accountId) && !state.debts.some((d) => d.id === g.accountId)
  const s = state.savings.find((x) => x.id === g.id)
  return g.target != null && (s?.saved ?? 0) >= g.target
}

// The month a goal is reached in a projection, or null if not within it.
export const goalMonth = (g: Goal, p: Projection): string | null =>
  g.kind === 'debt' ? (g.accountId ? p.paidOff[g.accountId] ?? null : null) : p.reached[g.id] ?? null

// The month a goal has to be reached by: its target date, or for a debt on a
// promo rate, the last month before the promo ends if that's sooner.
export function goalDeadline(g: Goal, state: PlanState, today: string): string | null {
  let by = g.by
  const debt = g.kind === 'debt' ? state.debts.find((d) => d.id === g.accountId) : undefined
  if (debt?.promoEnd && debt.promoEnd > today) {
    const promo = promoDeadline(debt.promoEnd)
    if (!by || promo < by) by = promo
  }
  return by
}

// The highest monthly spending (to $10) at which the test still passes; null
// if it fails even at $0. Later dates only ever come with more spending, so a
// binary search finds it.
export function maxSpending(plan: Plan, state: PlanState, ctx: Context, meets: (p: Projection) => boolean): number | null {
  if (!meets(project(plan, state, ctx, 0))) return null
  let lo = 0
  let hi = 30000
  if (meets(project(plan, state, ctx, hi))) return hi
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2
    if (meets(project(plan, state, ctx, mid))) lo = mid
    else hi = mid
  }
  return Math.floor(lo / 10) * 10
}

// Goals with a deadline that aren't done yet, and a test that all of them make it.
export function deadlineGoals(plan: Plan, state: PlanState, today: string) {
  return plan.goals
    .filter((g) => !goalDone(g, state))
    .map((g) => ({ goal: g, deadline: goalDeadline(g, state, today) }))
    .filter((x): x is { goal: Goal; deadline: string } => x.deadline != null)
}

export const meetsDeadline = (g: Goal, deadline: string) => (p: Projection) => (goalMonth(g, p) ?? '9999-12') <= deadline
