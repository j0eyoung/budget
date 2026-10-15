import { useCallback, useEffect, useMemo, useState } from 'react'
import { estimateMinimum, promoDeadline, simulatePayoff } from '../../shared/payoff.ts'
import type { DebtState, Payoff, Strategy } from '../../shared/payoff.ts'
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
  promo_apr: number | null
  promo_end: string | null
  plan_rank: number | null
  payments_per_month: number | null
  paydown_per_month: number | null
  history_days: number
}

const today = () => new Date().toISOString().slice(0, 10)
const promoActive = (d: Debt) => Boolean(d.promo_end && d.promo_end > today())

// Blank minimums are estimated at today's rate (the promo rate while one runs).
const minimumFor = (d: Debt) => estimateMinimum({ ...d, apr: promoActive(d) ? (d.promo_apr ?? 0) : d.apr })

const toState = (d: Debt, min = minimumFor(d).value): DebtState => ({
  id: d.id, name: d.name, type: d.type, balance: d.owed, apr: d.apr ?? 0, promoApr: d.promo_apr, promoEnd: d.promo_end, min,
})

const dateIn = (months: number | null) => (months == null ? 'never at this pace' : monthLabel(addMonths(thisMonth(), months)))

// What you've been paying, what's been added, and when the balance would hit
// zero at that payment if nothing new is charged.
function currentPace(d: Debt): string {
  if (d.payments_per_month == null || d.paydown_per_month == null) return 'not enough history yet'
  const paying = d.payments_per_month
  const charging = Math.max(0, paying - d.paydown_per_month)
  if (paying < 1) return charging > 1 ? `no payments seen · charging ${dollars(charging)}/mo` : 'no payments seen'
  const plan = simulatePayoff([toState(d, paying)], 0, 'avalanche', thisMonth())
  const charges = d.type === 'credit' && charging > 1 ? ` · charging ${dollars(charging)}/mo` : ''
  const when = plan.months == null ? 'never at this payment' : `${dateIn(plan.months)}${charges ? ' if new charges stop' : ''}`
  return `paying ${dollars(paying)}/mo${charges} → ${when}`
}

const STRATEGY_TITLES: Record<Strategy, string> = {
  plan: "Your plan's order",
  avalanche: 'Avalanche: highest rate first',
  snowball: 'Snowball: smallest balance first',
}

export function DebtPage({ onError }: { onError: (message: string) => void }) {
  const [debts, setDebts] = useState<Debt[]>([])
  const [extra, setExtra] = useState(() => pref.get('debtExtra', '200'))
  const [picked, setPicked] = useState<Strategy>(() => {
    const s = pref.get('debtStrategy', 'avalanche')
    return s === 'snowball' || s === 'plan' ? s : 'avalanche'
  })
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

  const inPlan = useMemo(() => debts.filter((d) => d.in_plan), [debts])
  const planDebts = useMemo(() => inPlan.map((d) => toState(d)), [inPlan])
  const planOrder = useMemo(
    () => inPlan.filter((d) => d.plan_rank != null).sort((a, b) => a.plan_rank! - b.plan_rank!).map((d) => d.id),
    [inPlan],
  )
  const strategies: Strategy[] = planOrder.length ? ['plan', 'avalanche', 'snowball'] : ['avalanche', 'snowball']
  const strategy = strategies.includes(picked) ? picked : 'avalanche'
  const extraNum = Math.max(0, Number(extra) || 0)
  const start = thisMonth()
  const results = useMemo(() => {
    const r: Partial<Record<Strategy | 'minimums', Payoff>> = { minimums: simulatePayoff(planDebts, 0, 'avalanche', start) }
    for (const s of strategies) r[s] = simulatePayoff(planDebts, extraNum, s, start, planOrder)
    return r
  }, [planDebts, extraNum, planOrder, start, strategies.length])
  const chosen = results[strategy]!
  const missingApr = inPlan.some((d) => d.apr == null)
  const totalOwed = debts.reduce((s, d) => s + d.owed, 0)
  const totalMin = planDebts.reduce((s, d) => s + d.min, 0)
  const pick = (s: Strategy) => {
    setPicked(s)
    pref.set('debtStrategy', s)
  }
  // Promo balances the chosen order doesn't clear before the promo ends.
  const promoMisses = inPlan.filter((d) => {
    if (!promoActive(d)) return false
    const k = chosen.payoff[d.id]
    return k == null || addMonths(start, k) > promoDeadline(d.promo_end!)
  })

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
                  <th>Account</th><th className="num">Owed</th><th className="num">APR %</th>
                  <th className="num opt" title="Promotional rate, e.g. 0% on a balance transfer">Promo %</th><th className="promo opt">Promo ends</th>
                  <th className="num">Min / mo</th><th className="pace">Current pace</th><th className="plan">In plan</th>
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
                      <td className="num opt">
                        <input className="amount small" type="number" min="0" step="0.01" placeholder="—" defaultValue={d.promo_apr ?? ''} key={`promo${d.promo_apr}`}
                          onBlur={(e) => (e.target.value === '' ? null : Number(e.target.value)) !== d.promo_apr && patch(d, { promo_apr: e.target.value })} />
                      </td>
                      <td className="promo opt">
                        <input type="date" defaultValue={d.promo_end ?? ''} key={`end${d.promo_end}`}
                          onBlur={(e) => (e.target.value || null) !== d.promo_end && patch(d, { promo_end: e.target.value || null, ...(e.target.value && d.promo_apr == null ? { promo_apr: 0 } : {}) })} />
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
                <tr>
                  <td>Total</td><td className="num">{money(totalOwed)}</td><td /><td className="opt" /><td className="opt" />
                  <td className="num">{dollars(totalMin)}</td><td className="pace" /><td className="plan" />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="muted">Current pace averages the last ~90 days of payments and new charges per account. Blank minimums are estimated; enter the real ones from your statements. A promo rate (like 0% on a card) applies until its end date. Leave a mortgage out of the plan: its payment is already part of your spending.</p>
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
          {promoMisses.map((d) => (
            <p className="notice warn" key={d.id}>
              ⚠ {d.org_name || d.name}: the {d.promo_apr ?? 0}% promo ends {d.promo_end}, but this order pays it off {dateIn(chosen.payoff[d.id] ?? null)}.
              {strategy === 'avalanche' ? ' Avalanche saves a 0% balance for last; put it earlier in your plan.' : ''}
            </p>
          ))}
          <div className="cards">
            <PlanCard title="Minimums only" plan={results.minimums!} />
            {strategies.map((s) => (
              <PlanCard key={s} title={STRATEGY_TITLES[s]} plan={results[s]!} active={strategy === s} onPick={() => pick(s)} />
            ))}
          </div>
          <h2 className="spaced">Payoff order <span className="muted">{STRATEGY_TITLES[strategy].toLowerCase()}</span></h2>
          {inPlan
            .slice()
            .sort((a, b) => (chosen.payoff[a.id] ?? 9999) - (chosen.payoff[b.id] ?? 9999))
            .map((d, i) => (
              <div className="account" key={d.id}>
                <div>{i + 1}. {d.name} <span className="muted">{money(d.owed)}{d.apr != null ? ` at ${d.apr}%` : ''}{promoActive(d) ? ` (${d.promo_apr ?? 0}% until ${d.promo_end})` : ''}</span></div>
                <div>{dateIn(chosen.payoff[d.id] ?? null)}</div>
              </div>
            ))}
        </section>
      )}
    </>
  )
}

function PlanCard({ title, plan, active, onPick }: { title: string; plan: Payoff; active?: boolean; onPick?: () => void }) {
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
