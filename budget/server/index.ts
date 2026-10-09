import crypto from 'node:crypto'
import path from 'node:path'
import express from 'express'
import { aiAvailable, ask, categorizeWithAi, generateInsights } from './ai.ts'
import { authStatus, loginState, logout, sendLoginCode, startLogin } from './claude.ts'
import { config } from './config.ts'
import { db, meta, runReadOnly } from './db.ts'
import { claimSetupToken, disconnect, isConnected, syncSimpleFin } from './simplefin.ts'

const app = express()
app.use(express.json())

// As an add-on the server listens on all interfaces: trust Home Assistant's
// ingress proxy, and require the API token from anything else (e.g. the
// Daily Briefing add-on or Claude Code on another machine).
const INGRESS_PROXY = '172.30.32.2'
app.use((req, res, next) => {
  if (!config.isAddon) return next()
  const ip = (req.socket.remoteAddress ?? '').replace('::ffff:', '')
  if (ip === INGRESS_PROXY) return next()
  if (config.apiToken && req.headers.authorization === `Bearer ${config.apiToken}`) return next()
  res.status(403).json({ error: 'Forbidden' })
})

const ACCOUNT_TYPES = ['depository', 'credit', 'loan', 'investment', 'other']
const currentMonth = () => new Date().toISOString().slice(0, 7)
const today = () => new Date().toISOString().slice(0, 10)

async function syncAndCategorize() {
  const result = await syncSimpleFin()
  let categorized = 0
  try {
    categorized = await categorizeWithAi()
  } catch (err: any) {
    result.errors.push(`AI categorization: ${err.message}`)
  }
  return { ...result, categorized }
}

app.get('/api/status', async (_req, res) => {
  res.json({ connected: isConnected(), lastSync: meta.get('last_sync'), aiConfigured: await aiAvailable() })
})

// Claude Code sign-in, driven from the Accounts tab.
app.get('/api/claude/status', async (_req, res) => {
  res.json({ ...(await authStatus()), login: loginState(), hasToken: Boolean(config.claudeOauthToken) })
})
app.post('/api/claude/login', (_req, res) => {
  startLogin()
  res.json(loginState())
})
app.post('/api/claude/login/code', (req, res) => {
  sendLoginCode(String(req.body.code ?? ''))
  res.json({ ok: true })
})
app.post('/api/claude/logout', async (_req, res) => {
  await logout()
  res.json({ ok: true })
})

app.post('/api/simplefin/connect', async (req, res) => {
  await claimSetupToken(String(req.body.setup_token ?? ''))
  res.json(await syncAndCategorize())
})

app.post('/api/simplefin/disconnect', (_req, res) => {
  disconnect()
  res.json({ ok: true })
})

app.post('/api/sync', async (_req, res) => {
  res.json(await syncAndCategorize())
})

// force=true re-labels everything the AI or default chose; user and rule picks stay.
app.post('/api/categorize', async (req, res) => {
  if (req.body?.force) db.prepare(`UPDATE transactions SET category_source = 'none' WHERE category_source = 'ai'`).run()
  res.json({ categorized: await categorizeWithAi(2000) })
})

app.get('/api/accounts', (_req, res) => {
  res.json(db.prepare('SELECT * FROM accounts ORDER BY source, org_name, name').all())
})

// Manual accounts cover institutions SimpleFIN can't reach (e.g. a loan servicer).
app.post('/api/accounts', (req, res) => {
  const id = `manual-${crypto.randomUUID()}`
  const type = ACCOUNT_TYPES.includes(req.body.type) ? req.body.type : 'other'
  const balance = Number(req.body.balance) || 0
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO accounts (id, source, org_name, name, type, balance, balance_date, updated_at)
    VALUES (?, 'manual', ?, ?, ?, ?, ?, ?)`).run(id, req.body.org_name || null, String(req.body.name).trim(), type, balance, today(), now)
  db.prepare('INSERT OR REPLACE INTO balance_snapshots (date, account_id, balance) VALUES (?, ?, ?)').run(today(), id, balance)
  res.json({ id })
})

app.patch('/api/accounts/:id', (req, res) => {
  const account = db.prepare('SELECT source FROM accounts WHERE id = ?').get(req.params.id) as { source: string } | undefined
  if (!account) return res.status(404).json({ error: 'No such account' })
  if (ACCOUNT_TYPES.includes(req.body.type)) db.prepare('UPDATE accounts SET type = ? WHERE id = ?').run(req.body.type, req.params.id)
  if (account.source === 'manual' && req.body.balance != null) {
    const balance = Number(req.body.balance) || 0
    db.prepare('UPDATE accounts SET balance = ?, balance_date = ?, updated_at = ? WHERE id = ?').run(balance, today(), new Date().toISOString(), req.params.id)
    db.prepare('INSERT OR REPLACE INTO balance_snapshots (date, account_id, balance) VALUES (?, ?, ?)').run(today(), req.params.id, balance)
  }
  res.json({ ok: true })
})

app.delete('/api/accounts/:id', (req, res) => {
  db.exec('BEGIN')
  db.prepare('DELETE FROM transactions WHERE account_id = ?').run(req.params.id)
  db.prepare('DELETE FROM balance_snapshots WHERE account_id = ?').run(req.params.id)
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id)
  db.exec('COMMIT')
  res.json({ ok: true })
})

app.get('/api/categories', (_req, res) => {
  res.json(db.prepare('SELECT id, name, kind FROM categories ORDER BY kind, name').all())
})

app.post('/api/categories', (req, res) => {
  const kind = ['expense', 'income', 'savings', 'transfer'].includes(req.body.kind) ? req.body.kind : 'expense'
  const info = db.prepare('INSERT INTO categories (name, kind) VALUES (?, ?)').run(String(req.body.name).trim(), kind)
  res.json({ id: info.lastInsertRowid })
})

app.get('/api/transactions', (req, res) => {
  const where: string[] = []
  const params: (string | number)[] = []
  if (req.query.month) { where.push('substr(t.date, 1, 7) = ?'); params.push(String(req.query.month)) }
  if (req.query.category) { where.push('t.category_id = ?'); params.push(Number(req.query.category)) }
  if (req.query.account) { where.push('t.account_id = ?'); params.push(String(req.query.account)) }
  if (req.query.q) { where.push('(t.name LIKE ? OR t.merchant LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`) }
  res.json(db.prepare(`
    SELECT t.id, t.date, t.name, t.merchant, t.amount, t.pending, t.category_id, t.category_source, a.name AS account_name
    FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY t.date DESC, t.id LIMIT 1000`).all(...params))
})

app.patch('/api/transactions/:id', (req, res) => {
  const categoryId = Number(req.body.category_id)
  db.prepare(`UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?`).run(categoryId, req.params.id)
  let alsoUpdated = 0
  if (req.body.remember) {
    const t = db.prepare('SELECT COALESCE(merchant, name) AS label FROM transactions WHERE id = ?').get(req.params.id) as { label: string }
    const pattern = t.label.toLowerCase()
    db.prepare('INSERT OR REPLACE INTO rules (pattern, category_id) VALUES (?, ?)').run(pattern, categoryId)
    alsoUpdated = Number(db.prepare(`
      UPDATE transactions SET category_id = ?, category_source = 'rule'
      WHERE lower(COALESCE(merchant, name)) = ? AND category_source != 'user'`).run(categoryId, pattern).changes)
  }
  res.json({ ok: true, alsoUpdated })
})

const budgetRows = (month: string) => db.prepare(`
  SELECT c.id, c.name, c.kind, COALESCE(b.amount, 0) AS budget,
    COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.category_id = c.id AND substr(t.date, 1, 7) = ?), 0) AS spent
  FROM categories c LEFT JOIN budgets b ON b.category_id = c.id
  ORDER BY c.kind, c.name`).all(month) as { id: number; name: string; kind: string; budget: number; spent: number }[]

app.get('/api/budget', (req, res) => {
  res.json(budgetRows(String(req.query.month || currentMonth())))
})

app.put('/api/budget/:categoryId', (req, res) => {
  const amount = Number(req.body.amount) || 0
  if (amount > 0) db.prepare('INSERT OR REPLACE INTO budgets (category_id, amount) VALUES (?, ?)').run(Number(req.params.categoryId), amount)
  else db.prepare('DELETE FROM budgets WHERE category_id = ?').run(Number(req.params.categoryId))
  res.json({ ok: true })
})

app.get('/api/networth', (_req, res) => {
  res.json(db.prepare(`
    SELECT date,
      SUM(CASE WHEN balance > 0 THEN balance ELSE 0 END) AS assets,
      SUM(CASE WHEN balance < 0 THEN -balance ELSE 0 END) AS debts
    FROM balance_snapshots GROUP BY date ORDER BY date`).all())
})

// Compact snapshot for the Daily Briefing add-on and other HA consumers.
app.get('/api/summary', (_req, res) => {
  const month = currentMonth()
  const rows = budgetRows(month)
  const expenses = rows.filter((r) => r.kind === 'expense')
  const accounts = db.prepare('SELECT name, org_name, type, balance, balance_date FROM accounts ORDER BY type, name').all() as any[]
  const assets = accounts.reduce((s, a) => s + Math.max(0, a.balance ?? 0), 0)
  const debts = accounts.reduce((s, a) => s + Math.max(0, -(a.balance ?? 0)), 0)
  res.json({
    asOf: meta.get('last_sync'),
    month,
    netWorth: assets - debts,
    assets,
    debts,
    spent: expenses.reduce((s, r) => s + r.spent, 0),
    budgeted: expenses.reduce((s, r) => s + r.budget, 0),
    income: -rows.filter((r) => r.kind === 'income').reduce((s, r) => s + r.spent, 0) || 0,
    saved: -rows.filter((r) => r.kind === 'savings').reduce((s, r) => s + r.spent, 0) || 0,
    overBudget: expenses.filter((r) => r.budget > 0 && r.spent > r.budget).map((r) => ({ category: r.name, spent: r.spent, budget: r.budget })),
    accounts,
    recent: db.prepare(`
      SELECT t.date, COALESCE(t.merchant, t.name) AS description, t.amount, c.name AS category, a.name AS account
      FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.amount > 0 ORDER BY t.date DESC, t.amount DESC LIMIT 10`).all(),
    insight: (db.prepare('SELECT content FROM insights WHERE month = ?').get(month) as { content: string } | undefined)?.content ?? null,
  })
})

app.get('/api/insights', (req, res) => {
  const month = String(req.query.month || currentMonth())
  res.json(db.prepare('SELECT month, content, created_at FROM insights WHERE month = ?').get(month) ?? null)
})

app.post('/api/insights', async (req, res) => {
  const month = String(req.body.month || currentMonth())
  res.json({ month, content: await generateInsights(month) })
})

app.post('/api/ask', async (req, res) => {
  res.json(await ask(String(req.body.question)))
})

// Read-only SQL, used by scripts/query.mjs so Claude Code can analyze the data.
app.post('/api/query', (req, res) => {
  res.json({ rows: runReadOnly(String(req.body.sql)) })
})

app.use(express.static(path.resolve(import.meta.dirname, '../dist')))

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err)
  res.status(500).json({ error: err?.message || 'Server error' })
})

const host = config.isAddon ? '0.0.0.0' : '127.0.0.1'
app.listen(config.port, host, () => {
  console.log(`Budget app listening on http://${host}:${config.port} (SimpleFIN: ${isConnected() ? 'connected' : 'not connected'}, Claude model: ${config.claudeModel})`)
})

// SimpleFIN allows roughly 24 requests a day; one scheduled sync per day,
// run at startup only if the last one is stale.
const DAY_MS = 24 * 60 * 60 * 1000
function scheduledSync() {
  if (!isConnected()) return
  syncAndCategorize().catch((err) => console.error('Scheduled sync failed:', err.message))
}
setInterval(scheduledSync, DAY_MS)
async function startup() {
  if (!isConnected() && config.simplefinSetupToken) {
    try {
      await claimSetupToken(config.simplefinSetupToken)
      console.log('Claimed SimpleFIN setup token')
    } catch (err: any) {
      console.error('SimpleFIN setup token claim failed:', err.message)
    }
  }
  const last = meta.get('last_sync')
  if (!last || Date.now() - new Date(last).getTime() > 20 * 60 * 60 * 1000) scheduledSync()
}
startup()
