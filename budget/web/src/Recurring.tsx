import { useEffect, useState } from 'react'
import { api, dollars, money } from './api.ts'

type Recurring = {
  merchant: string
  category: string
  cadence: string
  amount: number
  average: number
  monthly: number
  count: number
  lastDate: string
  nextDate: string
  variable: boolean
  increase: { from: number; to: number } | null
  stopped: boolean
}

export function RecurringPage({ onError }: { onError: (message: string) => void }) {
  const [items, setItems] = useState<Recurring[] | null>(null)
  useEffect(() => {
    api<Recurring[]>('recurring').then(setItems).catch((e) => onError(e.message))
  }, [onError])
  if (!items) return null

  const active = items.filter((r) => !r.stopped)
  const stopped = items.filter((r) => r.stopped)
  const monthly = active.reduce((s, r) => s + r.monthly, 0)
  const increases = active.filter((r) => r.increase)

  return (
    <>
      <div className="cards">
        <div className="card"><div className="muted">Recurring per month</div><div className="big">{dollars(monthly)}</div><div className="muted">{active.length} bills and subscriptions</div></div>
        <div className="card"><div className="muted">Per year</div><div className="big">{dollars(monthly * 12)}</div><div className="muted">at current prices</div></div>
        <div className="card"><div className="muted">Price increases</div><div className="big">{increases.length}</div><div className="muted">{increases.length ? increases.map((r) => r.merchant).join(', ') : 'none detected'}</div></div>
      </div>
      <section>
        <h2>Bills and subscriptions</h2>
        <p className="muted">Detected from repeat charges at the same merchant on a regular schedule. Needs at least two charges, so yearly ones show up after their second year.</p>
        <RecurringTable rows={active} />
      </section>
      {stopped.length > 0 && (
        <section>
          <h2>Possibly cancelled</h2>
          <p className="muted">These used to repeat but the expected charge hasn't shown up.</p>
          <RecurringTable rows={stopped} />
        </section>
      )}
    </>
  )
}

function RecurringTable({ rows }: { rows: Recurring[] }) {
  if (!rows.length) return <p className="muted">Nothing detected yet.</p>
  return (
    <div className="table-wrap">
      <table className="recurring-table">
        <thead>
          <tr><th>Merchant</th><th className="opt">Category</th><th className="cadence">How often</th><th className="num">Last charge</th><th className="num">Per month</th><th className="date">Next</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.merchant}-${r.amount}-${r.cadence}`}>
              <td title={r.merchant}>
                {r.merchant}
                {r.increase && <span className="badge up" title={`Was ${money(r.increase.from)}`}>▲ from {money(r.increase.from)}</span>}
                {r.variable && <span className="badge">varies</span>}
              </td>
              <td className="opt muted">{r.category}</td>
              <td className="cadence muted">{r.cadence}</td>
              <td className="num">{money(r.amount)}</td>
              <td className="num">{money(r.monthly)}</td>
              <td className="date muted">{r.stopped ? `last ${r.lastDate}` : r.nextDate}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
