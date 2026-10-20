import { db } from './db.ts'
import { planReport } from './plan.ts'
import { today } from './queries.ts'
import { HABIT_CATEGORIES, detectRecurring, normalize } from './recurring.ts'

// Weekly safe-to-spend: the plan's monthly spending limit, minus the regular
// bills the app detects (mortgage, utilities, insurance, subscriptions), spread
// over the weeks. Bills don't count against the week; everything else in
// spending does (loan payments excepted, as in the plan). Weeks run Monday to Sunday.

const DAY = 86400000
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)

export function safeToSpend() {
  const plan = planReport()
  // The tighter of "makes every payoff date" and the spending the user set.
  const limits = [plan.ceiling, plan.plan.spending].filter((x): x is number => x != null)
  const limit = limits.length ? Math.min(...limits) : null
  const basis = limit == null ? null : limit === plan.ceiling ? 'deadlines' : 'plan'

  // Gas, groceries and the like stay weekly spending even when they repeat.
  const bills = detectRecurring()
    .filter((b) => !b.stopped && b.category !== 'Debt Payments' && !HABIT_CATEGORIES.has(b.category))
    .map((b) => ({ key: b.key, merchant: b.merchant, category: b.category, monthly: Math.round(b.monthly) }))
  const billKeys = new Set(bills.map((b) => b.key))
  const fixed = bills.reduce((s, b) => s + b.monthly, 0)

  const date = today()
  const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7 // Monday = 0
  const weekStart = addDays(date, -weekday)
  const monthStart = `${date.slice(0, 7)}-01`
  const charges = (db.prepare(`
    SELECT l.date, COALESCE(l.merchant, l.name) AS label, l.amount, c.name AS category
    FROM ledger l JOIN categories c ON c.id = l.category_id
    WHERE c.kind = 'expense' AND c.name != 'Debt Payments' AND l.date >= ? AND l.date <= ?
    ORDER BY l.date DESC, l.amount DESC`).all(weekStart < monthStart ? weekStart : monthStart, date) as
    { date: string; label: string; amount: number; category: string }[])
    .filter((c) => !billKeys.has(normalize(c.label)))
  const sum = (rows: { amount: number }[]) => Math.round(rows.reduce((s, r) => s + r.amount, 0))
  const thisWeek = charges.filter((c) => c.date >= weekStart)

  const monthly = limit == null ? null : Math.max(0, limit - fixed)
  const weekly = monthly == null ? null : Math.round((monthly * 7) / 30.44)
  const spent = sum(thisWeek)
  return {
    limit,
    basis, // 'deadlines': the limit that makes every payoff date; 'plan': the user's planned spending
    fixed,
    bills: bills.sort((a, b) => b.monthly - a.monthly),
    monthly,
    weekly,
    weekStart,
    weekEnd: addDays(weekStart, 6),
    daysLeft: 7 - weekday,
    spent,
    left: weekly == null ? null : weekly - spent,
    charges: thisWeek.slice(0, 20).map((c) => ({ date: c.date, merchant: c.label, amount: c.amount, category: c.category })),
    monthSpent: sum(charges.filter((c) => c.date >= monthStart)),
  }
}

// For the daily briefing and /api/summary; never takes them down.
export function safeToSpendBrief() {
  try {
    const s = safeToSpend()
    return s.weekly == null ? null : { weekly: s.weekly, spent: s.spent, left: s.left, daysLeft: s.daysLeft, weekStart: s.weekStart, weekEnd: s.weekEnd }
  } catch (err: any) {
    console.error('Safe-to-spend failed:', err.message)
    return null
  }
}
