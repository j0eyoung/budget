import { db } from './db.ts'

export const today = () => new Date().toISOString().slice(0, 10)
export const currentMonth = () => today().slice(0, 7)

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7)
}

// The first day every regularly used spending account (checking, cards) has
// history for. An imported file can reach further back for one account than
// bank sync does for the rest, so averages only count months all of them cover.
export function historyStart(): string | null {
  const row = db.prepare(`
    SELECT MAX(first) AS d FROM (
      SELECT MIN(t.date) AS first FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.pending = 0 AND a.type IN ('depository', 'credit')
      GROUP BY t.account_id HAVING COUNT(*) >= 10)`).get() as { d: string | null }
  return row.d ?? (db.prepare('SELECT MIN(date) AS d FROM transactions WHERE pending = 0').get() as { d: string | null }).d
}

export type BudgetRow = {
  id: number
  name: string
  kind: string
  track: number
  budget: number
  spent: number
  prev: number
  avg3: number
}

// Per-category totals for a month, with last month and a 3-month average for
// comparison. Only months the synced history fully covers count toward the
// average, so a partial first month doesn't drag it down.
export function budgetRows(month: string): BudgetRow[] {
  const first = historyStart()
  const candidates = [1, 2, 3].map((n) => addMonths(month, -n))
  let avgMonths = first ? candidates.filter((m) => `${m}-01` >= first) : []
  if (!avgMonths.length && first) avgMonths = candidates.filter((m) => m >= first.slice(0, 7))
  const inList = avgMonths.length ? avgMonths.map(() => '?').join(', ') : `''`
  const rows = db.prepare(`
    SELECT c.id, c.name, c.kind, c.track, COALESCE(b.amount, 0) AS budget,
      COALESCE((SELECT SUM(l.amount) FROM ledger l WHERE l.category_id = c.id AND substr(l.date, 1, 7) = ?), 0) AS spent,
      COALESCE((SELECT SUM(l.amount) FROM ledger l WHERE l.category_id = c.id AND substr(l.date, 1, 7) = ?), 0) AS prev,
      COALESCE((SELECT SUM(l.amount) FROM ledger l WHERE l.category_id = c.id AND substr(l.date, 1, 7) IN (${inList})), 0) AS sum3
    FROM categories c LEFT JOIN budgets b ON b.category_id = c.id
    ORDER BY c.kind, c.name`).all(month, addMonths(month, -1), ...avgMonths) as (Omit<BudgetRow, 'avg3'> & { sum3: number })[]
  return rows.map(({ sum3, ...r }) => ({ ...r, avg3: avgMonths.length ? sum3 / avgMonths.length : 0 }))
}
