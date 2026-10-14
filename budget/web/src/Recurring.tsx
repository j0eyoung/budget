import { useCallback, useEffect, useState } from 'react'
import { api, dollars, money } from './api.ts'

type Recurring = {
  key: string
  confirmed: boolean
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
type Data = { items: Recurring[]; ignored: { key: string; label: string }[]; cadences: string[] }

export function RecurringPage({ onError }: { onError: (message: string) => void }) {
  const [data, setData] = useState<Data | null>(null)
  const load = useCallback(() => {
    api<Data>('recurring').then(setData).catch((e) => onError(e.message))
  }, [onError])
  useEffect(load, [load])

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      load()
    } catch (e: any) {
      onError(e.message)
    }
  }
  const actions: Actions = {
    setCadence: (r, cadence) => run(() => api('recurring', 'PUT', { key: r.key, label: r.merchant, status: 'yes', cadence })),
    ignore: (r) => run(() => api('recurring', 'PUT', { key: r.key, label: r.merchant, status: 'no' })),
    reset: (key) => run(() => api(`recurring/${encodeURIComponent(key)}`, 'DELETE')),
  }
  if (!data) return null

  const active = data.items.filter((r) => !r.stopped)
  const stopped = data.items.filter((r) => r.stopped)
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
        <p className="muted">
          Detected from repeat charges at the same merchant. Change how often or mark one as not recurring and it sticks.
          To add one that wasn't found (a yearly bill, say), use <strong>recurring</strong> on its transaction in Transactions.
        </p>
        <RecurringTable rows={active} cadences={data.cadences} actions={actions} />
      </section>
      {stopped.length > 0 && (
        <section>
          <h2>Possibly cancelled</h2>
          <p className="muted">These used to repeat but the expected charge hasn't shown up.</p>
          <RecurringTable rows={stopped} cadences={data.cadences} actions={actions} />
        </section>
      )}
      {data.ignored.length > 0 && (
        <section>
          <h2>Marked not recurring</h2>
          {data.ignored.map((i) => (
            <div className="account" key={i.key}>
              <div>{i.label}</div>
              <button className="link" onClick={() => actions.reset(i.key)}>Undo</button>
            </div>
          ))}
        </section>
      )}
    </>
  )
}

type Actions = {
  setCadence: (r: Recurring, cadence: string) => void
  ignore: (r: Recurring) => void
  reset: (key: string) => void
}

function RecurringTable({ rows, cadences, actions }: { rows: Recurring[]; cadences: string[]; actions: Actions }) {
  if (!rows.length) return <p className="muted">Nothing detected yet.</p>
  return (
    <div className="table-wrap">
      <table className="recurring-table">
        <thead>
          <tr>
            <th>Merchant</th><th className="opt">Category</th><th className="cadence">How often</th><th className="num opt">Last charge</th>
            <th className="num">Per month</th><th className="date opt">Next</th><th className="actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.key}-${r.amount}-${r.cadence}`}>
              <td title={r.merchant}>
                {r.merchant}
                {r.confirmed && <span className="badge" title="You confirmed this one">✓ yours</span>}
                {r.increase && <span className="badge up" title={`Was ${money(r.increase.from)}`}>▲ from {money(r.increase.from)}</span>}
                {r.variable && <span className="badge">varies</span>}
              </td>
              <td className="opt muted">{r.category}</td>
              <td className="cadence">
                <select value={r.cadence} onChange={(e) => actions.setCadence(r, e.target.value)}>
                  {cadences.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </td>
              <td className="num opt">{money(r.amount)}</td>
              <td className="num">{money(r.monthly)}</td>
              <td className="date opt muted">{r.stopped ? `last ${r.lastDate}` : r.nextDate}</td>
              <td className="actions">
                <button className="mini" onClick={() => actions.ignore(r)}>not recurring</button>
                {r.confirmed && <button className="mini" title="Back to automatic detection" onClick={() => actions.reset(r.key)}>reset</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
