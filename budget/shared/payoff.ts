// Debt payoff math shared by the server (Plan tab, daily briefing) and the
// browser (Debt tab). Plain functions over plain objects; months are 'YYYY-MM'.

export type DebtState = {
  id: string
  name: string
  type: string
  balance: number // owed, positive
  apr: number // percent; 0 when unknown
  promoApr: number | null
  promoEnd: string | null // 'YYYY-MM-DD'; the promo rate applies to the months before this one
  min: number
}

export type Strategy = 'avalanche' | 'snowball' | 'plan'

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7)
}

export const rateIn = (d: DebtState, month: string) =>
  d.promoEnd && month < d.promoEnd.slice(0, 7) ? (d.promoApr ?? 0) : d.apr

// The last month a promo balance can be cleared in and still beat the end
// date. A promo ending early in a month has to be paid off the month before,
// since the final payment has to post before the rate changes.
export function promoDeadline(promoEnd: string): string {
  return Number(promoEnd.slice(8, 10)) >= 25 ? promoEnd.slice(0, 7) : addMonths(promoEnd.slice(0, 7), -1)
}

// Minimum when none is entered: cards ~1% of the balance plus interest (at
// least $25); loans use what has actually been paid.
export function estimateMinimum(d: { type: string; owed: number; apr: number | null; min_payment: number | null; payments_per_month: number | null }): { value: number; estimated: boolean } {
  if (d.min_payment != null) return { value: d.min_payment, estimated: false }
  if (d.type === 'credit') return { value: Math.max(25, Math.round(d.owed * 0.01 + (d.owed * (d.apr ?? 0)) / 1200)), estimated: true }
  return { value: Math.round(d.payments_per_month ?? 0), estimated: true }
}

// One month (or the given part of one): interest accrues, then every open
// debt gets its minimum. Mutates the balances.
export function accrueAndPayMinimums(debts: DebtState[], month: string, fraction = 1): { interest: number; paid: number } {
  let interest = 0
  let paid = 0
  for (const d of debts) {
    if (d.balance <= 0) continue
    const i = (d.balance * rateIn(d, month) * fraction) / 1200
    d.balance += i
    interest += i
  }
  for (const d of debts) {
    if (d.balance <= 0) continue
    const pay = Math.min(d.min * fraction, d.balance)
    d.balance -= pay
    paid += pay
  }
  return { interest, paid }
}

// Puts an amount toward debts in the given order; returns what's left over.
export function payExtra(order: DebtState[], amount: number): number {
  for (const d of order) {
    if (amount <= 0) break
    if (d.balance <= 0) continue
    const pay = Math.min(amount, d.balance)
    d.balance -= pay
    amount -= pay
  }
  return amount
}

// Open debts in payoff order. Avalanche uses this month's rate, so a 0% promo
// balance waits until the promo ends. 'plan' follows planOrder (account ids).
export function priority(debts: DebtState[], month: string, strategy: Strategy, planOrder: string[] = []): DebtState[] {
  const open = debts.filter((d) => d.balance > 0)
  const rank = (d: DebtState) => (planOrder.includes(d.id) ? planOrder.indexOf(d.id) : planOrder.length)
  if (strategy === 'plan') return open.sort((a, b) => rank(a) - rank(b) || rateIn(b, month) - rateIn(a, month))
  if (strategy === 'snowball') return open.sort((a, b) => a.balance - b.balance)
  return open.sort((a, b) => rateIn(b, month) - rateIn(a, month) || a.balance - b.balance)
}

export type Payoff = { months: number | null; interest: number; payoff: Record<string, number> }

// Debt tab: a fixed monthly budget (every minimum plus extra) starting next
// month. A paid-off debt's minimum stays in the budget and rolls to the next.
// payoff maps debt id to months from now.
export function simulatePayoff(debts: DebtState[], extra: number, strategy: Strategy, startMonth: string, planOrder: string[] = []): Payoff {
  const ds = debts.map((d) => ({ ...d }))
  const budget = ds.reduce((s, d) => s + d.min, 0) + extra
  const payoff: Record<string, number> = {}
  let interest = 0
  for (let k = 1; k <= 600; k++) {
    const month = addMonths(startMonth, k)
    const r = accrueAndPayMinimums(ds, month)
    interest += r.interest
    payExtra(priority(ds, month, strategy, planOrder), budget - r.paid)
    for (const d of ds) {
      if (d.balance <= 0.005 && payoff[d.id] == null) {
        d.balance = 0
        payoff[d.id] = k
      }
    }
    if (ds.every((d) => d.balance <= 0)) return { months: k, interest, payoff }
  }
  return { months: null, interest, payoff }
}
