import { useCallback, useEffect, useState } from 'react'
import { api, money, thisMonth } from './api.ts'
import type { BudgetRow, Category, Status } from './api.ts'

const TABS = ['Dashboard', 'Transactions', 'Budget', 'Accounts', 'Ask'] as const
type Tab = (typeof TABS)[number]

export function App() {
  const [tab, setTab] = useState<Tab>('Dashboard')
  const [month, setMonth] = useState(thisMonth())
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState('')

  const loadStatus = useCallback(() => {
    api<Status>('status').then(setStatus).catch((e) => setError(e.message))
  }, [])
  useEffect(loadStatus, [loadStatus])

  return (
    <div className="app">
      <header>
        <h1>Budget</h1>
        <nav>
          {TABS.map((t) => (
            <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>
          ))}
        </nav>
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value || thisMonth())} />
      </header>
      {error && <p className="error" onClick={() => setError('')}>{error}</p>}
      {status && !status.connected && tab !== 'Accounts' && (
        <p className="notice">No bank connection yet. Go to Accounts and paste a SimpleFIN setup token.</p>
      )}
      <main>
        {tab === 'Dashboard' && <Dashboard month={month} status={status} onError={setError} />}
        {tab === 'Transactions' && <Transactions month={month} onError={setError} />}
        {tab === 'Budget' && <Budget month={month} onError={setError} />}
        {tab === 'Accounts' && <Accounts status={status} onError={setError} onStatus={loadStatus} />}
        {tab === 'Ask' && <Ask status={status} onError={setError} />}
      </main>
    </div>
  )
}

type PageProps = { onError: (message: string) => void }

function Dashboard({ month, status, onError }: PageProps & { month: string; status: Status | null }) {
  const [rows, setRows] = useState<BudgetRow[]>([])
  const [worth, setWorth] = useState<{ date: string; assets: number; debts: number }[]>([])
  const [insight, setInsight] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<BudgetRow[]>(`budget?month=${month}`).then(setRows).catch((e) => onError(e.message))
    api(`insights?month=${month}`).then((r) => setInsight(r?.content ?? null)).catch((e) => onError(e.message))
    api('networth').then(setWorth).catch((e) => onError(e.message))
  }, [month, onError])

  const expenses = rows.filter((r) => r.kind === 'expense')
  const spent = expenses.reduce((sum, r) => sum + r.spent, 0)
  const budgeted = expenses.reduce((sum, r) => sum + r.budget, 0)
  const income = -rows.filter((r) => r.kind === 'income').reduce((sum, r) => sum + r.spent, 0) || 0
  const saved = -rows.filter((r) => r.kind === 'savings').reduce((sum, r) => sum + r.spent, 0) || 0
  const latest = worth.at(-1)

  const generate = async () => {
    setBusy(true)
    try {
      setInsight((await api('insights', 'POST', { month })).content)
    } catch (e: any) {
      onError(e.message)
    }
    setBusy(false)
  }

  return (
    <>
      <div className="cards">
        <Card label="Spent" value={money(spent)} sub={budgeted ? `of ${money(budgeted)} budgeted` : 'no budget set'} />
        <Card label="Income" value={money(income)} sub={`${money(income - spent)} net`} />
        <Card label="Pre-tax savings" value={money(saved)} sub="401k, HSA, investment activity" />
        <Card label="Net worth" value={latest ? money(latest.assets - latest.debts) : '—'} sub={latest ? `${money(latest.debts)} owed` : 'connect an account'} />
      </div>
      <section>
        <h2>Spending by category</h2>
        {expenses.filter((r) => r.spent > 0 || r.budget > 0).sort((a, b) => b.spent - a.spent).map((r) => (
          <CategoryBar key={r.id} row={r} />
        ))}
        {!expenses.some((r) => r.spent > 0 || r.budget > 0) && <p className="muted">No spending recorded for this month.</p>}
      </section>
      {worth.length > 1 && (
        <section>
          <h2>Net worth over time</h2>
          <Sparkline values={worth.map((w) => w.assets - w.debts)} />
        </section>
      )}
      <section>
        <h2>Monthly insights</h2>
        {insight ? <p className="insight">{insight}</p> : <p className="muted">No review generated for this month yet.</p>}
        <button onClick={generate} disabled={busy}>
          {busy ? 'Generating…' : insight ? 'Regenerate' : 'Generate review'}
        </button>
        {status && !status.aiConfigured && <span className="muted"> Connect Claude in the Accounts tab first.</span>}
      </section>
    </>
  )
}

function Card({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card">
      <div className="muted">{label}</div>
      <div className="big">{value}</div>
      <div className="muted">{sub}</div>
    </div>
  )
}

function CategoryBar({ row }: { row: BudgetRow }) {
  const pct = row.budget ? Math.min(100, (row.spent / row.budget) * 100) : 100
  const over = row.budget > 0 && row.spent > row.budget
  return (
    <div className="bar-row">
      <div className="bar-label">
        <span>{row.name}</span>
        <span className={over ? 'over' : ''}>
          {money(row.spent)}{row.budget ? ` / ${money(row.budget)}` : ''}
        </span>
      </div>
      <div className="bar">
        <div className={`bar-fill ${over ? 'over-fill' : row.budget ? '' : 'unbudgeted'}`} style={{ width: `${Math.max(0, pct)}%` }} />
      </div>
    </div>
  )
}

function Sparkline({ values }: { values: number[] }) {
  const min = Math.min(...values)
  const range = Math.max(...values) - min || 1
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 100},${38 - ((v - min) / range) * 36}`).join(' ')
  return (
    <svg className="sparkline" viewBox="0 0 100 40" preserveAspectRatio="none">
      <polyline points={points} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Transactions({ month, onError }: PageProps & { month: string }) {
  const [rows, setRows] = useState<any[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  const [busy, setBusy] = useState(false)

  const recategorizeAll = async () => {
    setBusy(true)
    try {
      await api('categorize', 'POST', { force: true })
      load()
    } catch (e: any) {
      onError(e.message)
    }
    setBusy(false)
  }

  const load = useCallback(() => {
    const params = new URLSearchParams({ month })
    if (q) params.set('q', q)
    if (category) params.set('category', category)
    api(`transactions?${params}`).then(setRows).catch((e) => onError(e.message))
  }, [month, q, category, onError])

  useEffect(load, [load])
  useEffect(() => {
    api<Category[]>('categories').then(setCategories).catch((e) => onError(e.message))
  }, [onError])

  const recategorize = async (t: any, categoryId: number) => {
    const label = t.merchant || t.name
    const remember = window.confirm(`Always put "${label}" in this category?\n\nOK = this and all matching transactions\nCancel = just this one`)
    try {
      await api(`transactions/${encodeURIComponent(t.id)}`, 'PATCH', { category_id: categoryId, remember })
      load()
    } catch (e: any) {
      onError(e.message)
    }
  }

  return (
    <section>
      <div className="toolbar">
        <input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <span className="muted">{rows.length} transactions</span>
        <button onClick={recategorizeAll} disabled={busy}>{busy ? 'Categorizing…' : 'Re-run AI categories'}</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th className="date">Date</th><th>Description</th><th className="account">Account</th><th className="category">Category</th><th className="num">Amount</th></tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className={t.pending ? 'pending' : ''}>
                <td className="date">{t.date}</td>
                <td title={t.name}>{t.merchant || t.name}{t.pending ? ' (pending)' : ''}</td>
                <td className="account muted" title={t.account_name}>{t.account_name}</td>
                <td className="category">
                  <select value={t.category_id ?? ''} onChange={(e) => recategorize(t, Number(e.target.value))}>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <span className="tag">{t.category_source}</span>
                </td>
                <td className={`num ${t.amount < 0 ? 'inflow' : ''}`}>{money(-t.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Budget({ month, onError }: PageProps & { month: string }) {
  const [rows, setRows] = useState<BudgetRow[]>([])
  const load = useCallback(() => {
    api<BudgetRow[]>(`budget?month=${month}`).then(setRows).catch((e) => onError(e.message))
  }, [month, onError])
  useEffect(load, [load])

  const save = async (id: number, value: string) => {
    try {
      await api(`budget/${id}`, 'PUT', { amount: Number(value) || 0 })
      load()
    } catch (e: any) {
      onError(e.message)
    }
  }

  const addCategory = async () => {
    const name = window.prompt('New category name')
    if (!name?.trim()) return
    const kind = window.prompt('Kind: expense, income, savings or transfer', 'expense') || 'expense'
    try {
      await api('categories', 'POST', { name, kind })
      load()
    } catch (e: any) {
      onError(e.message)
    }
  }

  const expenses = rows.filter((r) => r.kind === 'expense')
  return (
    <section>
      <div className="toolbar">
        <span className="muted">Monthly targets apply to every month. Leave blank for no target.</span>
        <button onClick={addCategory}>Add category</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Category</th><th className="num">Monthly target</th><th className="num">Spent</th><th className="num">Remaining</th></tr>
          </thead>
          <tbody>
            {expenses.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td className="num">
                  <input className="amount" type="number" min="0" step="10" defaultValue={r.budget || ''} key={r.budget}
                    onBlur={(e) => Number(e.target.value || 0) !== r.budget && save(r.id, e.target.value)} />
                </td>
                <td className="num">{money(r.spent)}</td>
                <td className={`num ${r.budget && r.spent > r.budget ? 'over' : ''}`}>{r.budget ? money(r.budget - r.spent) : '—'}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td className="num">{money(expenses.reduce((s, r) => s + r.budget, 0))}</td>
              <td className="num">{money(expenses.reduce((s, r) => s + r.spent, 0))}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  )
}

const ACCOUNT_TYPES = ['depository', 'credit', 'loan', 'investment', 'other']

function Accounts({ status, onError, onStatus }: PageProps & { status: Status | null; onStatus: () => void }) {
  const [accounts, setAccounts] = useState<any[]>([])
  const [token, setToken] = useState('')
  const [manual, setManual] = useState({ name: '', org_name: '', type: 'loan', balance: '' })
  const [busy, setBusy] = useState('')
  const load = useCallback(() => {
    api('accounts').then(setAccounts).catch((e) => onError(e.message))
  }, [onError])
  useEffect(load, [load])

  const run = async (label: string, fn: () => Promise<any>) => {
    setBusy(label)
    try {
      const r = await fn()
      if (r?.errors?.length) onError(r.errors.join(' | '))
    } catch (e: any) {
      onError(e.message)
    }
    setBusy('')
    load()
    onStatus()
  }

  const connect = () => run('connect', async () => {
    const r = await api('simplefin/connect', 'POST', { setup_token: token })
    setToken('')
    return r
  })
  const sync = () => run('sync', () => api('sync', 'POST'))
  const disconnect = () => {
    if (window.confirm('Disconnect SimpleFIN? Synced accounts and transactions stay until you delete them.')) run('disconnect', () => api('simplefin/disconnect', 'POST'))
  }
  const addManual = () => run('manual', async () => {
    await api('accounts', 'POST', manual)
    setManual({ name: '', org_name: '', type: 'loan', balance: '' })
  })
  const setType = (a: any, type: string) => run('type', () => api(`accounts/${encodeURIComponent(a.id)}`, 'PATCH', { type }))
  const setBalance = (a: any, balance: string) => run('balance', () => api(`accounts/${encodeURIComponent(a.id)}`, 'PATCH', { balance }))
  const remove = (a: any) => {
    if (window.confirm(`Delete ${a.name} and its transactions from this app?`)) run('delete', () => api(`accounts/${encodeURIComponent(a.id)}`, 'DELETE'))
  }

  const groups = Object.entries(
    accounts.reduce<Record<string, any[]>>((g, a) => ((g[a.org_name || (a.source === 'manual' ? 'Manual' : 'Other')] ??= []).push(a), g), {}),
  )

  return (
    <>
      <section>
        <h2>SimpleFIN</h2>
        {status?.connected ? (
          <div className="toolbar">
            <span>Connected{status.lastSync ? `, last sync ${new Date(status.lastSync).toLocaleString()}` : ''}</span>
            <button onClick={sync} disabled={Boolean(busy)}>{busy === 'sync' ? 'Syncing…' : 'Sync now'}</button>
            <button className="link" onClick={disconnect} disabled={Boolean(busy)}>Disconnect</button>
          </div>
        ) : (
          <div className="toolbar">
            <input className="grow" placeholder="Paste a setup token from bridge.simplefin.org" value={token} onChange={(e) => setToken(e.target.value)} />
            <button onClick={connect} disabled={!token.trim() || Boolean(busy)}>{busy === 'connect' ? 'Connecting…' : 'Connect'}</button>
          </div>
        )}
        <p className="muted">SimpleFIN allows about 24 requests a day; the app syncs once a day on its own.</p>
      </section>

      {groups.map(([org, list]) => (
        <section key={org}>
          <h2>{org}</h2>
          {list.map((a) => (
            <div className="account" key={a.id}>
              <div>
                <div>{a.name}</div>
                <div className="muted">
                  <select value={a.type} onChange={(e) => setType(a, e.target.value)}>
                    {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  {' '}as of {a.balance_date}
                  {' '}<button className="link" onClick={() => remove(a)}>Delete</button>
                </div>
              </div>
              {a.source === 'manual' ? (
                <input className="amount" type="number" step="0.01" defaultValue={a.balance} key={a.balance}
                  onBlur={(e) => Number(e.target.value) !== a.balance && setBalance(a, e.target.value)} />
              ) : (
                <div className={`num ${a.balance < 0 ? 'over' : ''}`}>{money(a.balance)}</div>
              )}
            </div>
          ))}
        </section>
      ))}

      <ClaudeConnect onError={onError} onStatus={onStatus} />

      <section>
        <h2>Add a manual account</h2>
        <p className="muted">For anything SimpleFIN can't reach (e.g. a loan servicer). Enter balances owed as negative numbers.</p>
        <div className="toolbar">
          <input placeholder="Account name" value={manual.name} onChange={(e) => setManual({ ...manual, name: e.target.value })} />
          <input placeholder="Institution" value={manual.org_name} onChange={(e) => setManual({ ...manual, org_name: e.target.value })} />
          <select value={manual.type} onChange={(e) => setManual({ ...manual, type: e.target.value })}>
            {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input className="amount" type="number" step="0.01" placeholder="Balance" value={manual.balance} onChange={(e) => setManual({ ...manual, balance: e.target.value })} />
          <button onClick={addManual} disabled={!manual.name.trim() || Boolean(busy)}>Add</button>
        </div>
      </section>
    </>
  )
}


function ClaudeConnect({ onError, onStatus }: PageProps & { onStatus: () => void }) {
  const [state, setState] = useState<any>(null)
  const [code, setCode] = useState('')
  const load = useCallback(() => {
    api('claude/status').then(setState).catch((e) => onError(e.message))
  }, [onError])
  useEffect(load, [load])
  // While a sign-in is running, poll for the link and the final result.
  useEffect(() => {
    if (!state?.login?.running) return
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [state?.login?.running, load])

  const call = async (path: string, body?: unknown) => {
    try {
      await api(path, 'POST', body)
      load()
      onStatus()
    } catch (e: any) {
      onError(e.message)
    }
  }

  const signedIn = Boolean(state?.loggedIn && !state?.expired)
  // The app-level status (which gates the AI buttons) must follow the sign-in state.
  useEffect(() => {
    if (state) onStatus()
  }, [signedIn, state, onStatus])
  return (
    <section>
      <h2>Claude</h2>
      <p className="muted">Categorization, questions and monthly reviews run through Claude Code on your subscription. Nothing is sent anywhere else.</p>
      {signedIn ? (
        <div className="toolbar">
          <span>Signed in{state.authMethod ? ` (${state.authMethod})` : ''}</span>
          <button className="link" onClick={() => call('claude/logout')}>Sign out</button>
        </div>
      ) : state?.login?.running ? (
        <div>
          {state.login.url ? (
            <p>Open <a href={state.login.url} target="_blank" rel="noreferrer">this sign-in link</a>, approve, then paste the code here:</p>
          ) : (
            <p className="muted">Starting sign-in…</p>
          )}
          <div className="toolbar">
            <input className="grow" placeholder="Paste the code" value={code} onChange={(e) => setCode(e.target.value)} />
            <button onClick={() => { call('claude/login/code', { code }); setCode('') }} disabled={!code.trim()}>Submit</button>
          </div>
          {state.login.message && <p className="muted">{state.login.message}</p>}
        </div>
      ) : (
        <div className="toolbar">
          <button onClick={() => call('claude/login')}>Connect Claude</button>
          {state?.hasToken && <span className="muted">Using the token from the add-on options.</span>}
          {state?.expired && <span className="muted">Previous sign-in expired.</span>}
          {state?.login?.message && !state?.login?.running && <span className="muted">{state.login.message}</span>}
        </div>
      )}
    </section>
  )
}

function Ask({ status, onError }: PageProps & { status: Status | null }) {
  const [question, setQuestion] = useState('')
  const [log, setLog] = useState<{ question: string; answer: string; sql: string }[]>([])
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!question.trim()) return
    setBusy(true)
    try {
      const r = await api('ask', 'POST', { question })
      setLog((l) => [{ question, answer: r.answer, sql: r.sql }, ...l])
      setQuestion('')
    } catch (err: any) {
      onError(err.message)
    }
    setBusy(false)
  }

  return (
    <section>
      {status && !status.aiConfigured && <p className="notice">Connect Claude in the Accounts tab to use this.</p>}
      <form className="toolbar" onSubmit={submit}>
        <input className="grow" placeholder="How much did I spend on dining last month?" value={question} onChange={(e) => setQuestion(e.target.value)} />
        <button disabled={busy}>{busy ? 'Thinking…' : 'Ask'}</button>
      </form>
      {log.map((entry, i) => (
        <div className="qa" key={log.length - i}>
          <div className="question">{entry.question}</div>
          <p className="insight">{entry.answer}</p>
          <details>
            <summary className="muted">Query used</summary>
            <code>{entry.sql}</code>
          </details>
        </div>
      ))}
    </section>
  )
}
