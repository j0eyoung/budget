import { useCallback, useEffect, useMemo, useState } from 'react'
import { goalMonth, monthsBetween, project } from '../../shared/plan-math.ts'
import type { Context, Goal, GoalItem, Income, MonthRow, Plan, PlanEvent, PlanState, Projection, Raise, Schedule } from '../../shared/plan-math.ts'
import { api, dollars, money, monthLabel } from './api.ts'
import type { Status } from './api.ts'

// Shapes from server/plan.ts (planReport).
type GoalStatus = Goal & {
  account: string | null
  now: number
  deadline: string | null // target date, or the promo deadline if sooner
  projected: string | null // at the planned spending
  status: 'done' | 'on track' | 'behind' | 'no date' | 'not reachable' | 'no account'
  perMonth: number | null
  limit: number | null // most monthly spending that still makes the deadline
  cost: { low: number; high: number; actual: number; done: number } | null
}
type Pair = { plan: number; actual: number }
type PlanActual = { month: string; partial: boolean; income: Pair; spending: Pair; left: Pair; debtPaid: number | null }
type DebtTerm = {
  id: string; name: string; org_name: string | null; owed: number; apr: number | null; promo_apr: number | null
  promo_end: string | null; min_payment: number | null; min_estimate: number; in_plan: boolean
}
type Account = { id: string; name: string; org_name: string | null; type: string; balance: number }
type Report = {
  saved: boolean
  plan: Plan
  detected: { income: Income; spending: number | null }
  spending: { planned: number; actual: number | null; lastMonth: { month: string; amount: number } | null; usingActual: boolean }
  ceiling: number | null // most monthly spending that makes every deadline
  debtFree: string | null
  accounts: Account[]
  debtTerms: DebtTerm[]
  goals: GoalStatus[]
  promos: { id: string; name: string; short: string; promoApr: number; promoEnd: string; deadline: string; projected: string | null; ok: boolean }[]
  focus: { accountId: string; name: string; goal: string; type: string; owed: number; chargesThisMonth: number; count: number; recent: { date: string; merchant: string; amount: number }[] } | null
  windfalls: { date: string; amount: number; kind: string; sendTo: string | null }[]
  warnings: string[]
  model: { state: PlanState; ctx: Context }
  actual: PlanActual[]
}
type OnError = (message: string) => void

const SCHEDULES: Schedule[] = ['weekly', 'biweekly', 'semimonthly', 'monthly']
const SCHEDULE_LABELS: Record<Schedule, string> = { weekly: 'every week', biweekly: 'every 2 weeks', semimonthly: 'twice a month', monthly: 'once a month' }
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const when = (m: string | null | undefined) => (m ? monthLabel(m) : 'not in 10 yrs')

// On time / late for a goal, given the month it's reached at some spending level.
function timing(g: GoalStatus, reached: string | null): { label: string; tone: string } {
  if (g.status === 'done') return { label: 'done', tone: 'ok' }
  if (!reached) return { label: 'never at this spending', tone: 'bad' }
  if (!g.deadline) return { label: 'no target date', tone: '' }
  const late = monthsBetween(g.deadline, reached)
  if (late > 0) return { label: `${late} mo late`, tone: 'bad' }
  return { label: late < 0 ? `on time, ${-late} mo early` : 'on time', tone: 'ok' }
}

function Windfalls({ report }: { report: Report }) {
  return (
    <>
      {report.windfalls.map((w) => (
        <p className="notice good" key={`${w.date}${w.kind}`}>
          {w.kind === 'bonus' ? 'Bonus' : 'Third paycheck'} of {money(w.amount)} landed {w.date}{w.sendTo ? `. The plan sends it to: ${w.sendTo}.` : '.'}
        </p>
      ))}
    </>
  )
}

function FocusCharges({ report }: { report: Report }) {
  const f = report.focus
  if (f?.type !== 'credit' || !f.count) return null
  return (
    <p className="over small">
      {money(f.chargesThisMonth)} of new charges on {f.name} this month ({f.count}). That's the card you're paying off, so these push its payoff later.
    </p>
  )
}

// Dashboard summary: the spending limit and the next payoff dates.
export function PlanStrip({ onError, onOpen }: { onError: OnError; onOpen: () => void }) {
  const [report, setReport] = useState<Report | null>(null)
  useEffect(() => {
    api<Report>('plan').then(setReport).catch((e) => onError(e.message))
  }, [onError])
  if (!report || !report.goals.some((g) => g.deadline)) return null
  const next = report.goals.filter((g) => g.status !== 'done').slice(0, 3)
  const last = report.spending.lastMonth
  return (
    <section>
      <div className="chart-head">
        <h2>Payoff plan</h2>
        <button onClick={onOpen}>Open plan</button>
      </div>
      <Windfalls report={report} />
      {report.ceiling != null && (
        <p className="plan-limit">
          Spend under <strong>{dollars(report.ceiling)}/mo</strong> to make every payoff date.
          {last ? <span className="muted"> {monthLabel(last.month, false)}: {dollars(last.amount)}</span> : null}
        </p>
      )}
      {next.map((g) => {
        const t = timing(g, g.projected)
        return (
          <div className="account" key={g.id}>
            <div>{g.name}<div className="muted">{when(g.projected)}{g.deadline ? ` · target ${monthLabel(g.deadline)}` : ''}</div></div>
            <div className="right"><span className={`status ${t.tone}`}>{t.label}</span></div>
          </div>
        )
      })}
      <FocusCharges report={report} />
    </section>
  )
}

export function PlanPage({ status, onError }: { status: Status | null; onError: OnError }) {
  const [report, setReport] = useState<Report | null>(null)
  const [editing, setEditing] = useState(false)
  const [spend, setSpend] = useState<number | null>(null) // slider; null = the plan's spending
  const load = useCallback(() => {
    api<Report>('plan').then(setReport).catch((e) => onError(e.message))
  }, [onError])
  useEffect(load, [load])

  const s = spend ?? report?.spending.planned ?? 0
  const projection = useMemo(() => (report ? project(report.plan, report.model.state, report.model.ctx, s) : null), [report, s])

  const savePlan = async (plan: Plan) => {
    try {
      setReport(await api<Report>('plan', 'PUT', { plan }))
    } catch (e: any) {
      onError(e.message)
    }
  }
  const setGoal = (id: string, patch: Partial<Goal>) => report && savePlan({ ...report.plan, goals: report.plan.goals.map((g) => (g.id === id ? { ...g, ...patch } : g)) })
  // Ticking a cost item done or entering what it cost saves straight away.
  const updateItem = (goalId: string, index: number, patch: Partial<GoalItem>) => {
    const g = report?.plan.goals.find((x) => x.id === goalId)
    if (g) setGoal(goalId, { items: g.items.map((it, i) => (i === index ? { ...it, ...patch } : it)) })
  }
  const edit = (on: boolean) => {
    setEditing(on)
    window.scrollTo(0, 0)
  }

  if (!report || !projection) return <section><p className="muted">Loading the plan…</p></section>
  if (editing) {
    return <PlanEditor report={report} aiReady={Boolean(status?.aiConfigured)} onError={onError} onDone={(r) => { if (r) { setReport(r); setSpend(null) } edit(false) }} />
  }

  const { goals, spending } = report
  const last = spending.lastMonth
  const debtGoals = goals.filter((g) => g.kind === 'debt')
  const savingsGoals = goals.filter((g) => g.kind === 'savings')
  const hasDeadlines = goals.some((g) => g.deadline)
  const presets = [
    last && { label: `${monthLabel(last.month, false)} actual`, value: last.amount },
    spending.actual != null && { label: '3-month average', value: spending.actual },
    report.ceiling != null && { label: 'Makes every date', value: report.ceiling },
    report.plan.spending != null && { label: 'Your plan', value: report.plan.spending },
  ].filter((p): p is { label: string; value: number } => Boolean(p))
  const values = [s, ...presets.map((p) => p.value)]
  const lo = Math.max(0, Math.floor((Math.min(...values) * 0.6) / 100) * 100)
  const hi = Math.ceil((Math.max(...values) * 1.25) / 100) * 100
  const next = projection.rows[1] ?? projection.rows[0]
  const left = next.income - next.spending - next.minimums
  const aiming = report.model.state.debts.find((d) => d.balance > 0)?.short ?? 'savings'
  const noApr = report.model.state.debts.filter((d) => d.aprMissing)

  return (
    <>
      {!report.saved && (
        <div className="notice">
          This is a starting point built from your accounts. Put a target date on each debt below, or use <strong>Edit plan</strong> to import a written plan
          and set your income, raises and bonuses.
        </div>
      )}
      <Windfalls report={report} />

      <section className="plan-hero">
        {report.ceiling != null ? (
          <>
            <div className="muted">To make every payoff date, keep monthly spending under</div>
            <div className="hero-number">{dollars(report.ceiling)}<span>/mo</span></div>
          </>
        ) : hasDeadlines ? (
          <div className="hero-text">Some target dates are too soon to make at any spending level. Move them later below.</div>
        ) : (
          <div className="hero-text">Give your debts target dates below to see how much you can spend each month and still make them.</div>
        )}
        <div className="muted">
          {last ? `In ${monthLabel(last.month, false)} you spent ${dollars(last.amount)}` : ''}
          {spending.actual != null ? `${last ? '; ' : ''}the 3-month average is ${dollars(spending.actual)}` : ''}
          {last || spending.actual != null ? '. ' : ''}
          Spending means everything except loan and credit card payments, mortgage included.
        </div>
      </section>

      <section>
        <div className="chart-head">
          <h2>Try a spending level</h2>
          {report.plan.spending !== s && <button onClick={() => savePlan({ ...report.plan, spending: s })}>Use {dollars(s)}/mo as my plan</button>}
        </div>
        <div className="slider">
          <input type="range" min={lo} max={hi} step={50} value={s} onChange={(e) => setSpend(Number(e.target.value))} aria-label="Monthly spending" />
          <strong>{dollars(s)}/mo</strong>
        </div>
        <div className="chips">
          {presets.map((p) => (
            <button key={p.label} className={`toggle ${Math.abs(p.value - s) < 25 ? 'on' : ''}`} onClick={() => setSpend(p.value)}>
              {p.label}: {dollars(p.value)}
            </button>
          ))}
        </div>
        <p className="math">
          {monthLabel(next.month, false)}: income {dollars(next.income)} − spending {dollars(next.spending)} − minimum payments {dollars(next.minimums)} ={' '}
          {left >= 0
            ? <strong className="inflow">{dollars(left)} extra toward {aiming}</strong>
            : <strong className="over">{dollars(-left)} short</strong>}
        </p>
        {left < 0 && <p className="over small">At this level the month comes up short, so the gap lands on a card and balances grow instead of shrinking.</p>}
        <p className="muted">Debt-free: <strong>{when(projection.debtFree)}</strong> at {dollars(s)}/mo.</p>
      </section>

      <section>
        <div className="chart-head">
          <h2>Payoff dates <span className="muted">at {dollars(s)}/mo</span></h2>
          <button onClick={() => edit(true)}>Edit plan</button>
        </div>
        <GoalTable goals={debtGoals} projection={projection} report={report} onTarget={(id, by) => setGoal(id, { by })} />
        <FocusCharges report={report} />
        {noApr.length > 0 && <p className="muted">No APR entered for {noApr.map((d) => d.short).join(', ')}, so it counts as 0% (after any promo). Add it in the Debt tab.</p>}
        <p className="muted">
          Debts are paid off top to bottom: minimums on all of them, everything left over on the top one. "OK up to" is the most you can spend per month and still
          make that date. A promo balance has to be gone the month before its promo ends.
        </p>
      </section>

      {savingsGoals.length > 0 && (
        <section>
          <h2>Savings goals <span className="muted">after the debts, at {dollars(s)}/mo</span></h2>
          <GoalTable goals={savingsGoals} projection={projection} report={report} onTarget={(id, by) => setGoal(id, { by })} />
        </section>
      )}

      {goals.filter((g) => g.items.length > 0).map((g) => (
        <CostItems key={g.id} goal={g} onChange={(i, patch) => updateItem(g.id, i, patch)} />
      ))}
      <PlanVsActual rows={report.actual} />
      <MonthByMonth rows={visibleMonths(projection, goals)} />
    </>
  )
}

function GoalTable({ goals, projection, report, onTarget }: {
  goals: GoalStatus[]
  projection: Projection
  report: Report
  onTarget: (id: string, by: string | null) => void
}) {
  const debt = goals[0]?.kind === 'debt'
  return (
    <div className="table-wrap">
      <table className="plan-table">
        <thead>
          <tr>
            <th>{debt ? 'Debt' : 'Goal'}</th><th className="num">{debt ? 'Owed' : 'Saved'}</th>
            <th className="when">Target date</th><th className="when">{debt ? 'Paid off' : 'Reached'}</th><th className="status-col">Status</th>
          </tr>
        </thead>
        <tbody>
          {goals.map((g, i) => {
            const reached = g.status === 'done' ? null : goalMonth(g, projection)
            const t = timing(g, reached)
            const promo = report.promos.find((p) => p.id === g.accountId)
            return (
              <tr key={g.id}>
                <td title={g.account ?? ''}>
                  {i + 1}. {g.name}
                  <div className="muted">
                    {g.account ?? (debt ? 'no account picked' : 'not linked to an account')}
                    {promo ? ` · ${promo.promoApr}% until ${promo.promoEnd}` : ''}
                    {!debt && g.target != null ? ` · target ${dollars(g.target)}` : ''}
                  </div>
                </td>
                <td className="num">{money(g.now)}</td>
                <td className="when">
                  <input type="month" value={g.by ?? ''} onChange={(e) => onTarget(g.id, e.target.value || null)} aria-label={`Target date for ${g.name}`} />
                  {g.deadline && g.deadline !== g.by && <div className="muted">promo: by {monthLabel(g.deadline)}</div>}
                </td>
                <td className="when">{g.status === 'done' ? 'done' : when(reached)}</td>
                <td className="status-col">
                  <span className={`status ${t.tone}`}>{t.label}</span>
                  {g.limit != null && <div className="muted">OK up to {dollars(g.limit)}/mo</div>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// Months up to the last milestone, plus a few after.
function visibleMonths(p: Projection, goals: GoalStatus[]): MonthRow[] {
  const milestones = [p.debtFree, ...goals.map((g) => goalMonth(g, p))].filter((m): m is string => Boolean(m))
  if (!milestones.length) return p.rows.slice(0, 36)
  const last = milestones.reduce((a, b) => (b > a ? b : a))
  return p.rows.slice(0, Math.min(120, Math.max(12, monthsBetween(p.rows[0].month, last) + 4)))
}

function CostItems({ goal, onChange }: { goal: GoalStatus; onChange: (index: number, patch: Partial<GoalItem>) => void }) {
  const cost = goal.cost!
  return (
    <section>
      <h2>
        {goal.name} costs
        <span className="muted">estimate {dollars(cost.low)}–{dollars(cost.high)} · {cost.done} of {goal.items.length} done{cost.actual ? ` · ${dollars(cost.actual)} spent` : ''}</span>
      </h2>
      <div className="table-wrap">
        <table className="items-table">
          <thead><tr><th>Item</th><th className="num opt">Low</th><th className="num opt">High</th><th className="num">Actual</th><th className="done-col">Done</th></tr></thead>
          <tbody>
            {goal.items.map((it, i) => (
              <tr key={`${i}${it.name}`}>
                <td title={it.name}>{it.name}<div className="muted only-narrow">{dollars(it.low)}–{dollars(it.high)}</div></td>
                <td className="num opt">{dollars(it.low)}</td>
                <td className="num opt">{dollars(it.high)}</td>
                <td className="num">
                  <NumInput value={it.actual} placeholder="—" onChange={(v) => onChange(i, { actual: v })} />
                </td>
                <td className="done-col"><input type="checkbox" checked={it.done} onChange={(e) => onChange(i, { done: e.target.checked })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function PlanVsActual({ rows }: { rows: PlanActual[] }) {
  if (!rows.length) return null
  const cell = (pair: Pair, higherIsBetter: boolean, partial: boolean) => {
    const diff = pair.actual - pair.plan
    const bad = higherIsBetter ? !partial && diff < -50 : diff > 50
    return (
      <td className="num">
        <span className={bad ? 'over' : ''}>{dollars(pair.actual)}</span>
        <div className="muted">plan {dollars(pair.plan)}</div>
      </td>
    )
  }
  return (
    <section>
      <h2>Plan vs actual</h2>
      <div className="table-wrap">
        <table className="pva-table">
          <thead>
            <tr><th>Month</th><th className="num">Income</th><th className="num">Spending</th><th className="num">Left over</th><th className="num opt">Debt paid down</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.month}>
                <td>{monthLabel(r.month)}{r.partial && <div className="muted">so far</div>}</td>
                {cell(r.income, true, r.partial)}
                {cell(r.spending, false, r.partial)}
                {cell(r.left, true, r.partial)}
                <td className="num opt">{r.debtPaid == null ? '—' : <span className={r.debtPaid < 0 ? 'over' : ''}>{dollars(r.debtPaid)}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">
        Spending leaves out loan payments, which the plan pays as debts. Left over is income minus spending: what's there for debts and savings. Debt paid down is payments
        minus new charges on the plan's debts; negative means they grew.
      </p>
    </section>
  )
}

function MonthByMonth({ rows }: { rows: MonthRow[] }) {
  return (
    <section>
      <details>
        <summary><strong>Month by month</strong> <span className="muted">{rows.length} months</span></summary>
        <div className="table-wrap">
          <table className="months-table">
            <thead>
              <tr>
                <th>Month</th><th className="num">Income</th><th className="num opt">Spending</th><th className="num opt">Minimums</th>
                <th className="num">Extra to debt</th><th className="num">To savings</th><th className="num opt">Debt left</th><th className="num opt">Saved</th><th className="notes">Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.month}>
                  <td>{monthLabel(r.month)}</td>
                  <td className="num">{dollars(r.income)}</td>
                  <td className="num opt">{dollars(r.spending)}</td>
                  <td className="num opt">{dollars(r.minimums)}</td>
                  <td className="num">{r.borrowed ? <span className="over">−{dollars(r.borrowed)}</span> : dollars(r.toDebt)}</td>
                  <td className="num">{r.drawn ? <span className="over">−{dollars(r.drawn)}</span> : dollars(r.toSavings)}</td>
                  <td className="num opt">{dollars(r.debtLeft)}</td>
                  <td className="num opt">{dollars(r.saved)}</td>
                  <td className="notes" title={r.notes.join(', ')}>{r.notes.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted">
          This month counts from today. A red amount means income didn't cover spending and minimums that month: the gap comes out of savings, or goes on a card.
        </p>
      </details>
    </section>
  )
}

// Number field that commits on blur, so half-typed values ("12.") never get
// rewritten. Remounts when the value changes from outside (an import).
function NumInput({ value, onChange, placeholder, step = '0.01', className = 'amount' }: {
  value: number | null
  onChange: (v: number | null) => void
  placeholder?: string
  step?: string
  className?: string
}) {
  return (
    <input className={className} type="number" step={step} placeholder={placeholder} defaultValue={value ?? ''} key={String(value)}
      onBlur={(e) => {
        const v = e.target.value === '' ? null : Number(e.target.value)
        if (v !== value && (v == null || Number.isFinite(v))) onChange(v)
      }} />
  )
}

type Terms = Pick<DebtTerm, 'id' | 'name' | 'org_name' | 'owed' | 'apr' | 'promo_apr' | 'promo_end' | 'min_payment' | 'min_estimate' | 'in_plan'>

function PlanEditor({ report, aiReady, onError, onDone }: { report: Report; aiReady: boolean; onError: OnError; onDone: (r?: Report) => void }) {
  const [plan, setPlan] = useState<Plan>(() => structuredClone(report.plan))
  const [terms, setTerms] = useState<Terms[]>(() => report.debtTerms.map((d) => ({ ...d })))
  const [text, setText] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const income = plan.income
  const detected = report.detected.income

  const setIncome = (patch: Partial<Income>) => setPlan((p) => ({ ...p, income: { ...p.income, ...patch } }))
  const setRaise = (i: number, patch: Partial<Raise>) => setIncome({ raises: income.raises.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  const setEvent = (i: number, patch: Partial<PlanEvent>) => setPlan((p) => ({ ...p, events: p.events.map((e, j) => (j === i ? { ...e, ...patch } : e)) }))
  const setGoal = (i: number, patch: Partial<Goal>) => setPlan((p) => ({ ...p, goals: p.goals.map((g, j) => (j === i ? { ...g, ...patch } : g)) }))
  const setItem = (gi: number, ii: number, patch: Partial<GoalItem>) =>
    setGoal(gi, { items: plan.goals[gi].items.map((it, j) => (j === ii ? { ...it, ...patch } : it)) })
  const moveGoal = (i: number, by: number) =>
    setPlan((p) => {
      const j = i + by
      if (j < 0 || j >= p.goals.length) return p
      const goals = [...p.goals]
      ;[goals[i], goals[j]] = [goals[j], goals[i]]
      return { ...p, goals }
    })
  const addGoal = (kind: Goal['kind']) =>
    setPlan((p) => ({ ...p, goals: [...p.goals, { id: `g${Date.now().toString(36)}`, kind, name: '', accountId: null, target: null, by: null, items: [] }] }))
  const setTerm = (id: string, patch: Partial<Terms>) => setTerms((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)))

  const debtAccounts = report.accounts.filter((a) => a.balance < 0 && ['credit', 'loan', 'other'].includes(a.type))
  const savingsAccounts = report.accounts.filter((a) => ['depository', 'investment'].includes(a.type))

  const readPlan = async () => {
    setBusy('import')
    setNotice('')
    try {
      const r = await api<{ plan: Plan; debts: Partial<Terms>[] }>('plan/import', 'POST', { text })
      setPlan(r.plan)
      setTerms((ts) => ts.map((t) => {
        const d = r.debts.find((x) => x.id === t.id)
        if (!d) return t
        return {
          ...t,
          apr: d.apr ?? t.apr,
          promo_apr: d.promo_apr ?? t.promo_apr,
          promo_end: d.promo_end ?? t.promo_end,
          min_payment: d.min_payment ?? t.min_payment,
        }
      }))
      setNotice('Filled in from your plan. Check each section (amounts, order, accounts, changes), then click Save plan. Nothing is saved yet.')
    } catch (e: any) {
      onError(e.message)
    }
    setBusy('')
  }

  const save = async () => {
    setBusy('save')
    try {
      const debts = terms.map(({ id, apr, promo_apr, promo_end, min_payment }) => ({ id, apr, promo_apr, promo_end, min_payment }))
      onDone(await api<Report>('plan', 'PUT', { plan, debts }))
    } catch (e: any) {
      onError(e.message)
      setBusy('')
    }
  }

  const reset = async () => {
    if (!window.confirm('Throw away this plan and start again from your accounts? Debt APRs and promo dates stay.')) return
    try {
      onDone(await api<Report>('plan', 'DELETE'))
    } catch (e: any) {
      onError(e.message)
    }
  }

  const actions = (
    <div className="toolbar tight">
      <button onClick={() => onDone()} disabled={Boolean(busy)}>Cancel</button>
      <button className="primary" onClick={save} disabled={Boolean(busy)}>{busy === 'save' ? 'Saving…' : 'Save plan'}</button>
    </div>
  )

  return (
    <>
      <section>
        <div className="chart-head">
          <h2>Edit plan</h2>
          {actions}
        </div>
        {notice && <p className="notice good">{notice}</p>}
        <details open={!report.saved}>
          <summary>Import a written plan</summary>
          <p className="muted">
            Paste a plan, like a handoff from another AI chat. Claude reads it into the fields below so you can check them; nothing is saved until you click
            Save plan. How often you're paid stays as detected from your deposits.
          </p>
          <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the plan text…" />
          <div className="toolbar">
            <button onClick={readPlan} disabled={!aiReady || text.trim().length < 40 || Boolean(busy)}>{busy === 'import' ? 'Reading…' : 'Read with Claude'}</button>
            {!aiReady && <span className="muted">Connect Claude in the Accounts tab first.</span>}
          </div>
        </details>
      </section>

      <section>
        <h2>Income</h2>
        <div className="form-grid">
          <label>Paycheck after tax <NumInput value={income.paycheck} onChange={(v) => setIncome({ paycheck: v ?? 0 })} /></label>
          <label>Paid
            <select value={income.schedule} onChange={(e) => setIncome({ schedule: e.target.value as Schedule })}>
              {SCHEDULES.map((s) => <option key={s} value={s}>{SCHEDULE_LABELS[s]}</option>)}
            </select>
          </label>
          {(income.schedule === 'weekly' || income.schedule === 'biweekly') && (
            <label>A recent payday <input type="date" value={income.lastPayday} onChange={(e) => e.target.value && setIncome({ lastPayday: e.target.value })} /></label>
          )}
          <label>Side income / month <NumInput value={income.side} onChange={(v) => setIncome({ side: v ?? 0 })} /></label>
        </div>
        <p className="muted">
          From your deposits: {money(detected.paycheck)} {SCHEDULE_LABELS[detected.schedule]}
          {detected.bonuses.length ? `; bonuses ${detected.bonuses.map((b) => `${MONTH_NAMES[b.month - 1]} ${dollars(b.amount)}`).join(', ')}` : ''}
          {detected.side ? `; other income about ${dollars(detected.side)}/mo` : ''}.
          {detected.bonuses.length < 2 ? ' Bank sync only reaches back about 90 days; import older history (Accounts tab) to pick up the rest of your bonuses.' : ''}
        </p>

        <h3>Bonuses</h3>
        {income.bonuses.length > 0 && (
          <table className="form-table">
            <thead><tr><th>Paid in</th><th>Amount after tax</th><th /></tr></thead>
            <tbody>
              {income.bonuses.map((b) => (
                <tr key={b.month}>
                  <td>{MONTH_NAMES[b.month - 1]}</td>
                  <td><NumInput value={b.amount} onChange={(v) => setIncome({ bonuses: income.bonuses.map((x) => (x.month === b.month ? { ...x, amount: v ?? 0 } : x)) })} /></td>
                  <td><button className="link" onClick={() => setIncome({ bonuses: income.bonuses.filter((x) => x.month !== b.month) })}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <select className="mini-add" value="" onChange={(e) => {
          const month = Number(e.target.value)
          if (month) setIncome({ bonuses: [...income.bonuses, { month, amount: income.bonuses.at(-1)?.amount ?? 0 }].sort((a, b) => a.month - b.month) })
        }}>
          <option value="">+ Add a bonus month…</option>
          {MONTH_NAMES.map((name, i) => !income.bonuses.some((b) => b.month === i + 1) && <option key={name} value={i + 1}>{name}</option>)}
        </select>
        <p className="muted">Amounts at today's pay. A raise grows them by the same share.</p>

        <h3>Raises</h3>
        {income.raises.length > 0 && (
          <table className="form-table">
            <thead><tr><th>From</th><th>New paycheck</th><th /></tr></thead>
            <tbody>
              {income.raises.map((r, i) => (
                <tr key={i}>
                  <td><input type="month" value={r.month} onChange={(e) => setRaise(i, { month: e.target.value })} /></td>
                  <td><NumInput value={r.paycheck} onChange={(v) => setRaise(i, { paycheck: v ?? 0 })} /></td>
                  <td><button className="link" onClick={() => setIncome({ raises: income.raises.filter((_, j) => j !== i) })}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <button className="mini-add" onClick={() => setIncome({ raises: [...income.raises, { month: '', paycheck: income.paycheck }] })}>+ Add raise</button>
      </section>

      <section>
        <h2>Spending</h2>
        <label>Planned monthly spending
          <NumInput value={plan.spending} placeholder={report.spending.actual != null ? String(report.spending.actual) : ''}
            onChange={(v) => setPlan((p) => ({ ...p, spending: v != null && v > 0 ? v : null }))} />
        </label>
        <p className="muted">
          Everything except loan and credit card payments: mortgage, utilities, insurance, food, gas, subscriptions.
          {report.spending.actual != null ? ` Leave it blank to use your actual 3-month average (${dollars(report.spending.actual)}).` : ''}
        </p>
      </section>

      <section>
        <h2>Changes</h2>
        <p className="muted">One-off costs (negative) or money in (positive) in a month, or a monthly change from that month on: a cancelled subscription (+), rent coming in (+).</p>
        {plan.events.length > 0 && (
          <table className="form-table">
            <thead><tr><th>Month</th><th>What</th><th>Amount</th><th>Every month</th><th /></tr></thead>
            <tbody>
              {plan.events.map((e, i) => (
                <tr key={i}>
                  <td><input type="month" value={e.month} onChange={(ev) => setEvent(i, { month: ev.target.value })} /></td>
                  <td><input value={e.label} onChange={(ev) => setEvent(i, { label: ev.target.value })} /></td>
                  <td><NumInput value={e.amount} onChange={(v) => setEvent(i, { amount: v ?? 0 })} /></td>
                  <td className="center"><input type="checkbox" checked={e.monthly} onChange={(ev) => setEvent(i, { monthly: ev.target.checked })} /></td>
                  <td><button className="link" onClick={() => setPlan((p) => ({ ...p, events: p.events.filter((_, j) => j !== i) }))}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <button className="mini-add" onClick={() => setPlan((p) => ({ ...p, events: [...p.events, { month: '', label: '', amount: 0, monthly: false }] }))}>+ Add change</button>
      </section>

      <section>
        <h2>Goals, in order</h2>
        <p className="muted">
          Debts are paid off top to bottom, then savings goals fill top to bottom. Savings goals on the same account stack: the first counts the balance
          up to its target, the next gets the rest.
        </p>
        {plan.goals.map((g, i) => (
          <div className="goal-edit" key={g.id}>
            <div className="toolbar">
              <span className="muted">{i + 1}.</span>
              <select value={g.kind} onChange={(e) => setGoal(i, { kind: e.target.value as Goal['kind'], accountId: null, target: null })}>
                <option value="debt">Pay off</option>
                <option value="savings">Save</option>
              </select>
              <input className="grow" placeholder={g.kind === 'debt' ? 'e.g. Citi paid off' : 'e.g. Emergency fund'} value={g.name}
                onChange={(e) => setGoal(i, { name: e.target.value })} />
              <select value={g.accountId ?? ''} onChange={(e) => setGoal(i, { accountId: e.target.value || null })}>
                <option value="">{g.kind === 'debt' ? 'Pick the debt…' : 'No account'}</option>
                {(g.kind === 'debt' ? debtAccounts : savingsAccounts).map((a) => (
                  <option key={a.id} value={a.id}>{a.org_name ? `${a.org_name}: ` : ''}{a.name}</option>
                ))}
              </select>
              {g.kind === 'savings' && <label>Target <NumInput value={g.target} placeholder="amount" onChange={(v) => setGoal(i, { target: v })} /></label>}
              <label>By <input type="month" value={g.by ?? ''} onChange={(e) => setGoal(i, { by: e.target.value || null })} /></label>
              <button className="toggle" title="Move up" onClick={() => moveGoal(i, -1)} disabled={i === 0}>↑</button>
              <button className="toggle" title="Move down" onClick={() => moveGoal(i, 1)} disabled={i === plan.goals.length - 1}>↓</button>
              <button className="link" onClick={() => setPlan((p) => ({ ...p, goals: p.goals.filter((_, j) => j !== i) }))}>Remove</button>
            </div>
            {g.kind === 'savings' && (
              <div className="items-edit">
                {g.items.length > 0 && (
                  <table className="form-table">
                    <thead><tr><th>Cost item</th><th>Low</th><th>High</th><th>Actual</th><th>Done</th><th /></tr></thead>
                    <tbody>
                      {g.items.map((it, j) => (
                        <tr key={j}>
                          <td><input value={it.name} onChange={(e) => setItem(i, j, { name: e.target.value })} /></td>
                          <td><NumInput value={it.low} onChange={(v) => setItem(i, j, { low: v ?? 0 })} /></td>
                          <td><NumInput value={it.high} onChange={(v) => setItem(i, j, { high: v ?? 0 })} /></td>
                          <td><NumInput value={it.actual} placeholder="—" onChange={(v) => setItem(i, j, { actual: v })} /></td>
                          <td className="center"><input type="checkbox" checked={it.done} onChange={(e) => setItem(i, j, { done: e.target.checked })} /></td>
                          <td><button className="link" onClick={() => setGoal(i, { items: g.items.filter((_, k) => k !== j) })}>Remove</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <button className="mini-add" onClick={() => setGoal(i, { items: [...g.items, { name: '', low: 0, high: 0, actual: null, done: false }] })}>
                  + Cost item (for a project like a build)
                </button>
              </div>
            )}
          </div>
        ))}
        <div className="toolbar spaced">
          <button onClick={() => addGoal('debt')}>Add a debt to pay off</button>
          <button onClick={() => addGoal('savings')}>Add a savings goal</button>
        </div>
      </section>

      {terms.length > 0 && (
        <section>
          <h2>Debt terms</h2>
          <p className="muted">The same numbers as the Debt tab. A promo rate (like 0% on a card) applies until its end date, and the plan warns if a promo balance won't be gone in time.</p>
          <div className="table-wrap">
            <table className="form-table">
              <thead><tr><th>Debt</th><th>Owed</th><th>APR %</th><th>Promo %</th><th>Promo ends</th><th>Min / mo</th></tr></thead>
              <tbody>
                {terms.map((t) => (
                  <tr key={t.id}>
                    <td>{t.org_name || t.name}<div className="muted">{t.name}</div></td>
                    <td className="num">{money(t.owed)}</td>
                    <td><NumInput value={t.apr} placeholder="rate" onChange={(v) => setTerm(t.id, { apr: v })} /></td>
                    <td><NumInput value={t.promo_apr} placeholder="—" onChange={(v) => setTerm(t.id, { promo_apr: v })} /></td>
                    <td>
                      <input type="date" value={t.promo_end ?? ''}
                        onChange={(e) => setTerm(t.id, { promo_end: e.target.value || null, ...(e.target.value && t.promo_apr == null ? { promo_apr: 0 } : {}) })} />
                    </td>
                    <td><NumInput value={t.min_payment} placeholder={`${t.min_estimate} est.`} onChange={(v) => setTerm(t.id, { min_payment: v })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="toolbar">
        <button className="link left" onClick={reset} disabled={Boolean(busy)}>Start over from my accounts</button>
        <span className="grow" />
        {actions}
      </div>
    </>
  )
}
