import { useEffect, useState } from 'react'
import { api, dollars, money } from './api.ts'

type Allowance = {
  limit: number | null
  basis: 'deadlines' | 'plan' | null
  fixed: number
  bills: { key: string; merchant: string; category: string; monthly: number }[]
  monthly: number | null
  weekly: number | null
  weekStart: string
  weekEnd: string
  daysLeft: number
  spent: number
  left: number | null
  charges: { date: string; merchant: string; amount: number; category: string }[]
  monthSpent: number
}

const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })

// Dashboard: what's left of this week's spending money once bills are covered.
export function SafeToSpend({ onError, onOpenPlan }: { onError: (m: string) => void; onOpenPlan: () => void }) {
  const [s, setS] = useState<Allowance | null>(null)
  useEffect(() => {
    api<Allowance>('safe-to-spend').then(setS).catch((e) => onError(e.message))
  }, [onError])
  if (!s) return null

  if (s.weekly == null) {
    return (
      <section className="allowance">
        <div className="chart-head">
          <h2>Safe to spend this week</h2>
          <button onClick={onOpenPlan}>Open plan</button>
        </div>
        <p className="muted">Give your debts target dates in the Plan tab (or set a planned spending amount) and this shows how much you can spend each week and still stay on track.</p>
      </section>
    )
  }

  const left = s.left ?? 0
  const over = left < 0
  const used = s.weekly > 0 ? Math.min(100, (s.spent / s.weekly) * 100) : 100
  return (
    <section className="allowance">
      <div className="chart-head">
        <h2>Safe to spend this week <span className="muted">{day(s.weekStart)} – {day(s.weekEnd)}</span></h2>
      </div>
      <div className="allowance-main">
        <span className={`hero-number ${over ? 'over' : ''}`}>{dollars(Math.abs(left))}</span>
        <span className="muted"> {over ? 'over' : 'left'} of {dollars(s.weekly)}</span>
      </div>
      <div className="bar"><div className={`bar-fill ${over ? 'over-fill' : ''}`} style={{ width: `${used}%` }} /></div>
      <p className="muted">
        {dollars(s.spent)} spent · {s.daysLeft} {s.daysLeft === 1 ? 'day' : 'days'} left
        {!over && s.daysLeft > 0 ? ` · about ${dollars(left / s.daysLeft)} a day` : ''}
        {s.monthly != null && <> · <span className={s.monthSpent > s.monthly ? 'over' : ''}>this month {dollars(s.monthSpent)} of {dollars(s.monthly)}</span></>}
      </p>
      {s.weekly === 0 && <p className="over small">Regular bills ({dollars(s.fixed)}/mo) already use up the whole {dollars(s.limit)} monthly limit.</p>}
      <details>
        <summary className="muted">How it's worked out</summary>
        <p className="muted">
          {s.basis === 'deadlines' ? `Spending under ${dollars(s.limit)}/mo makes every payoff date in your plan.` : `Your plan's spending is ${dollars(s.limit)}/mo.`}{' '}
          Regular bills take {dollars(s.fixed)} of that, leaving {dollars(s.monthly)}/mo, or {dollars(s.weekly)} a week, for everything else. Bills and loan payments
          don't count against the week; mark a charge as recurring (or not) in the Recurring tab to move it.
        </p>
        <div className="allowance-cols">
          <div>
            <h3>This week</h3>
            {s.charges.length ? s.charges.map((c, i) => (
              <div className="line" key={i}><span>{c.merchant}<span className="muted"> · {c.category}</span></span><span className={c.amount < 0 ? 'inflow' : ''}>{money(c.amount)}</span></div>
            )) : <p className="muted">Nothing yet.</p>}
          </div>
          <div>
            <h3>Regular bills <span className="muted">{dollars(s.fixed)}/mo</span></h3>
            {s.bills.map((b) => (
              <div className="line" key={`${b.key}${b.monthly}`}><span>{b.merchant}<span className="muted"> · {b.category}</span></span><span>{dollars(b.monthly)}/mo</span></div>
            ))}
          </div>
        </div>
      </details>
    </section>
  )
}
