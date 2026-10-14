import { useCallback, useEffect, useMemo, useState } from 'react'
import { addMonths, api, dollars, money, monthLabel, pref, thisMonth } from './api.ts'

type Debt = {
  id: string
  name: string
  org_name: string | null
  type: string
  source: string
  owed: number
  apr: number | null
  min_payment: number | null
  in_plan: boolean
  payments_per_month: number | null
  paydown_per_month: number | null
  history_days: number
}

type PlanDebt = { id: string; balance: number; apr: number; min: number }
type Plan = { months: number | null; interest: number; payoff: Record<string, number> }

// Month-by-month payoff: interest accrues, every debt gets its minimum, and
// whatever is left of the fixed monthly budget goes to the priority debt.
// A paid-off debt's minimum stays in the budget, so it rolls to the next one.
function simulate(debts: PlanDebt[], extra: number, strategy: 'avalanche' | 'snowball'): Plan {
  const ds = debts.map((d) => ({ ...d }))
  const budget = ds.reduce((s, d) => s + d.min, 0) + extra
  const payoff: Record<string, number> = {}
  let interest = 0
  for (let month = 1; month <= 600; month++) {
    for (const d of ds) {
      if (d.balance <= 0) continue
      const i = (d.balance * d.apr) / 1200
      d.balance += i
      interest += i
    }
    let pool = budget
    for (const d of ds) {
      if (d.balance <= 0) continue
      const pay = Math.min(d.min, d.balance, pool)
      d.balance -= pay
      pool -= pay
    }
    const order = ds.filter((d) => d.balance > 0).sort(strategy === 'avalanche'
      ? (a, b) => b.apr - a.apr || a.balance - b.balance
      : (a, b) => a.balance - b.balance)
    for (const d of order) {
      if (pool <= 0) break
      const pay = Math.min(pool, d.balance)
      d.balance -= pay
      pool -= pay
    }
    for (const d of ds) {
      if (d.balance <= 0.005 && payoff[d.id] == null) {
        d.balance = 0
        payoff[d.id] = month
      }
    }
    if (ds.every((d) => d.balance <= 0)) return { months: month, interest, payoff }
  }
  return { months: null, interest, payoff }
}

// Minimum when none is entered: cards ~1% of balance plus interest (at least $25);
// loans use what's actually been paid.
function minimumFor(d: Debt): { value: number; estimated: boolean } {
  if (d.min_payment != null) return { value: d.min_payment, estimated: false }
  if (d.type === 'credit') return { value: Math.max(25, Math.round(d.owed * 0.01 + (d.owed * (d.apr ?? 0)) / 1200)), estimated: true }
  return { value: Math.round(d.payments_per_month ?? 0), estimated: true }
}

const dateIn = (months: number | null) => (months == null ? 'never at this pace' : monthLabel(addMonths(thisMonth(), months)))

// What you've been paying, what's been added, and when the balance would hit
// zero at that payment if nothing new is charged.
function currentPace(d: Debt): string {
  if (d.payments_per_month == null || d.paydown_per_month == null) return 'not enough history yet'
  const paying = d.payments_per_month
  const charging = Math.max(0, paying - d.paydown_per_month)
  if (paying < 1) return charging > 1 ? `no payments seen · charging ${dollars(charging)}/mo` : 'no payments seen'
  const plan = simulate([{ id: d.id, balance: d.owed, apr: d.apr ?? 0, min: paying }], 0, 'avalanche')
  const charges = d.type === 'credit' && charging > 1 ? ` · charging ${dollars(charging)}/mo` : ''
  const when = plan.months == null ? 'never at this payment' : `${dateIn(plan.months)}${charges ? ' if new charges stop' : ''}`
  return `paying ${dollars(paying)}/mo${charges} → ${when}`
}

export function DebtPage({ onError }: { onError: (message: string) => void }) {
  const [debts, setDebts] = useState<Debt[]>([])
  const [extra, setExtra] = useState(() => pref.get('debtExtra', '200'))
  const [strategy, setStrategy] = useState<'avalanche' | 'snowball'>(() => (pref.get('debtStrategy', 'avalanche') === 'snowball' ? 'snowball' : 'avalanche'))
  const load = useCallback(() => {
    api<Debt[]>('debts').then(setDebts).catch((e) => onError(e.message))
  }, [onError])
  useEffect(load, [load])

  const patch = async (d: Debt, body: Record<string, unknown>) => {
    try {
      await api(`accounts/${encodeURIComponent(d.id)}`, 'PATCH', body)
      load()
    } catch (e: any) {
      onError(e.message)
    }
  }

  const planDebts = useMemo(
    () => debts.filter((d) => d.in_plan).map((d) => ({ id: d.id, balance: d.owed, apr: d.apr ?? 0, min: minimumFor(d).value })),
    [debts],
  )
  const extraNum = Math.max(0, Number(extra) || 0)
  const results = useMemo(() => ({
    minimums: simulate(planDebts, 0, strategy),
    avalanche: simulate(planDebts, extraNum, 'avalanche'),
    snowball: simulate(planDebts, extraNum, 'snowball'),
  }), [planDebts, extraNum, strategy])
  const chosen = results[strategy]
  const missingApr = debts.some((d) => d.in_plan && d.apr == null)
  const totalOwed = debts.reduce((s, d) => s + d.owed, 0)
  const totalMin = planDebts.reduce((s, d) => s + d.min, 0)

  return (
    <>
      <section>
        <h2>Debts</h2>
        {!debts.length && <p className="muted">No balances owed.</p>}
        {debts.length > 0 && (
          <div className="table-wrap">
            <table className="debt-table">
              <thead>
                <tr>
                  <th>Account</th><th className="num">Owed</th><th className="num">APR %</th><th className="num">Min / mo</th>
                  <th className="pace">Current pace</th><th className="plan">In plan</th>
                </tr>
              </thead>
              <tbody>
                {debts.map((d) => {
                  const min = minimumFor(d)
                  return (
                    <tr key={d.id}>
                      <td title={d.org_name ?? ''}>{d.name}<div className="muted">{d.org_name}</div></td>
                      <td className="num">{money(d.owed)}</td>
                      <td className="num">
                        <input className="amount small" type="number" min="0" step="0.01" placeholder="rate" defaultValue={d.apr ?? ''} key={`apr${d.apr}`}
                          onBlur={(e) => (e.target.value === '' ? null : Number(e.target.value)) !== d.apr && patch(d, { apr: e.target.value })} />
                      </td>
                      <td className="num">
                        <input className="amount small" type="number" min="0" step="1" placeholder={`${min.value} est.`} defaultValue={d.min_payment ?? ''} key={`min${d.min_payment}`}
                          onBlur={(e) => (e.target.value === '' ? null : Number(e.target.value)) !== d.min_payment && patch(d, { min_payment: e.target.value })} />
                      </td>
                      <td className="pace muted">{currentPace(d)}</td>
                      <td className="plan"><input type="checkbox" checked={d.in_plan} onChange={(e) => patch(d, { in_plan: e.target.checked })} /></td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr><td>Total</td><td className="num">{money(totalOwed)}</td><td /><td className="num">{dollars(totalMin)}</td><td className="pace" /><td className="plan" /></tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="muted">Current pace averages the last ~90 days of payments and new charges per account. Blank minimums are estimated; enter the real ones from your statements.</p>
      </section>

      {planDebts.length > 0 && (
        <section>
          <h2>Payoff plan</h2>
          <div className="toolbar">
            <label>Extra per month above minimums
              <input className="amount" type="number" min="0" step="25" value={extra}
                onChange={(e) => { setExtra(e.target.value); pref.set('debtExtra', e.target.value) }} />
            </label>
            <span className="muted">Total {dollars(totalMin + extraNum)}/mo. Assumes no new charges on the cards.</span>
          </div>
          {missingApr && <p className="notice">Some debts have no APR yet; they count as 0% interest, so dates are optimistic.</p>}
          <div className="cards">
            <PlanCard title="Minimums only" plan={results.minimums} />
            <PlanCard title="Avalanche: highest rate first" plan={results.avalanche} active={strategy === 'avalanche'}
              onPick={() => { setStrategy('avalanche'); pref.set('debtStrategy', 'avalanche') }} />
            <PlanCard title="Snowball: smallest balance first" plan={results.snowball} active={strategy === 'snowball'}
              onPick={() => { setStrategy('snowball'); pref.set('debtStrategy', 'snowball') }} />
          </div>
          <h2 className="spaced">Payoff order ({strategy})</h2>
          {debts
            .filter((d) => d.in_plan)
            .sort((a, b) => (chosen.payoff[a.id] ?? 9999) - (chosen.payoff[b.id] ?? 9999))
            .map((d, i) => (
              <div className="account" key={d.id}>
                <div>{i + 1}. {d.name} <span className="muted">{money(d.owed)}{d.apr != null ? ` at ${d.apr}%` : ''}</span></div>
                <div>{dateIn(chosen.payoff[d.id] ?? null)}</div>
              </div>
            ))}
        </section>
      )}
    </>
  )
}

function PlanCard({ title, plan, active, onPick }: { title: string; plan: Plan; active?: boolean; onPick?: () => void }) {
  return (
    <div className={`card ${active ? 'card-active' : ''} ${onPick ? 'clickable' : ''}`} onClick={onPick}>
      <div className="muted">{title}</div>
      <div className="big">{plan.months == null ? 'Never' : dateIn(plan.months)}</div>
      <div className="muted">
        {plan.months == null ? 'payments don’t cover interest' : `${plan.months} months · ${dollars(plan.interest)} interest`}
      </div>
    </div>
  )
}
