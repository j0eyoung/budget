import { useEffect, useState } from 'react'
import { api, dollars, monthLabel, thisMonth } from './api.ts'

type Month = { month: string; income: number; spending: number; net: number; debtPayments: number; debtEnd: number | null }

// Income vs spending per month as paired bars, with the month's net under
// each pair. Every bar has a hover tooltip; the net row doubles as the table view.
export function CashFlow({ onError }: { onError: (message: string) => void }) {
  const [months, setMonths] = useState<Month[]>([])
  const [hover, setHover] = useState<{ m: Month; series: 'income' | 'spending' } | null>(null)

  useEffect(() => {
    api<Month[]>('cashflow?months=12').then(setMonths).catch((e) => onError(e.message))
  }, [onError])

  if (!months.length) return null
  const max = Math.max(1, ...months.flatMap((m) => [m.income, m.spending]))
  const current = thisMonth()

  return (
    <section>
      <div className="chart-head">
        <h2>Cash flow</h2>
        <div className="legend">
          <span><i className="swatch income" />Income</span>
          <span><i className="swatch spending" />Spending</span>
        </div>
      </div>
      <div className="cashflow" onMouseLeave={() => setHover(null)}>
        {months.map((m) => (
          <div className="cf-month" key={m.month}>
            <div className="cf-bars">
              {(['income', 'spending'] as const).map((s) => (
                <div key={s} className="cf-hit" onMouseEnter={() => setHover({ m, series: s })}
                  onClick={() => setHover({ m, series: s })}>
                  <div className={`cf-bar ${s}`} style={{ height: `${(Math.max(0, m[s]) / max) * 100}%` }} />
                </div>
              ))}
            </div>
            <div className="cf-label">{monthLabel(m.month, false)}{m.month === current ? '*' : ''}</div>
            <div className={`cf-net ${m.net >= 0 ? 'pos' : 'neg'}`}>{m.net >= 0 ? '+' : '−'}{dollars(Math.abs(m.net))}</div>
          </div>
        ))}
      </div>
      {hover ? (
        <p className="cf-tip">
          <strong>{monthLabel(hover.m.month)}</strong>: income {dollars(hover.m.income)}, spending {dollars(hover.m.spending)}
          {hover.m.debtPayments ? ` (incl. ${dollars(hover.m.debtPayments)} loan payments)` : ''}, net {hover.m.net >= 0 ? '+' : '−'}{dollars(Math.abs(hover.m.net))}
          {hover.m.debtEnd != null ? `. Owed at month end: ${dollars(hover.m.debtEnd)}` : ''}
        </p>
      ) : (
        <p className="muted cf-tip">Net = income minus spending. Card purchases count when made; card payments are transfers. * month in progress.</p>
      )}
    </section>
  )
}
