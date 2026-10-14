import { db } from './db.ts'
import { today } from './queries.ts'

const DAY = 86400000

// Debts plus what the last ~90 days say about how fast each is shrinking.
// payments_per_month: money paid in. paydown_per_month: payments minus new
// charges and interest, i.e. how much the balance actually drops.
export function debtSummary() {
  const accounts = db.prepare(`
    SELECT id, name, org_name, type, source, balance, apr, min_payment, in_plan
    FROM accounts WHERE balance < 0 AND type IN ('credit', 'loan', 'other') ORDER BY balance`).all() as any[]
  const firstTx = db.prepare('SELECT MIN(date) AS d FROM transactions WHERE account_id = ? AND pending = 0')
  const flows = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN l.amount < 0 AND c.kind = 'transfer' THEN -l.amount ELSE 0 END), 0) AS payments,
      COALESCE(SUM(l.amount), 0) AS net
    FROM ledger l LEFT JOIN categories c ON c.id = l.category_id
    WHERE l.account_id = ? AND l.pending = 0 AND l.date >= ?`)
  const now = Date.parse(today())

  return accounts.map((a) => {
    const first = (firstTx.get(a.id) as { d: string | null }).d
    const days = first ? Math.min(90, Math.round((now - Date.parse(first)) / DAY)) : 0
    let payments: number | null = null
    let paydown: number | null = null
    if (days >= 25) {
      const since = new Date(now - days * DAY).toISOString().slice(0, 10)
      const f = flows.get(a.id, since) as { payments: number; net: number }
      payments = (f.payments * 30.44) / days
      paydown = (-f.net * 30.44) / days
    }
    return {
      id: a.id,
      name: a.name,
      org_name: a.org_name,
      type: a.type,
      source: a.source,
      owed: -a.balance,
      apr: a.apr,
      min_payment: a.min_payment,
      in_plan: Boolean(a.in_plan),
      payments_per_month: payments,
      paydown_per_month: paydown,
      history_days: days,
    }
  })
}
