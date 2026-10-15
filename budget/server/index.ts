import crypto from 'node:crypto'
import path from 'node:path'
import express from 'express'
import { aiAvailable, ask, categorizeWithAi, generateInsights } from './ai.ts'
import { briefingData, cachedBriefing, generateBriefing } from './briefing.ts'
import { authStatus, loginState, logout, sendLoginCode, startLogin } from './claude.ts'
import { config } from './config.ts'
import { backupDb, categoryIdByName, db, meta, runReadOnly } from './db.ts'
import { debtSummary } from './debts.ts'
import { syncHealth } from './health.ts'
import { importPlan, planBrief, planDebtOrder, planReport, resetPlan, savePlan } from './plan.ts'
import { addMonths, budgetRows, currentMonth, today } from './queries.ts'
import { readReceipt } from './receipt.ts'
import { CADENCES, clearRecurringOverride, detectRecurring, ignoredRecurring, setRecurringOverride } from './recurring.ts'
import { claimSetupToken, disconnect, isConnected, syncSimpleFin } from './simplefin.ts'

const app = express()
// Large enough for a CSV import of a few thousand rows or a receipt photo.
app.use(express.json({ limit: '10mb' }))

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
const optionalNumber = (v: unknown) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v))

async function syncAndCategorize() {
  let result
  try {
    result = await syncSimpleFin()
    meta.delete('last_sync_failure')
  } catch (err: any) {
    meta.set('last_sync_failure', JSON.stringify({ at: new Date().toISOString(), message: err.message }))
    throw err
  }
  let categorized = 0
  try {
    categorized = await categorizeWithAi()
  } catch (err: any) {
    result.errors.push(`AI categorization: ${err.message}`)
  }
  return { ...result, categorized }
}

app.get('/api/status', async (_req, res) => {
  res.json({ connected: isConnected(), lastSync: meta.get('last_sync'), aiConfigured: await aiAvailable(), health: syncHealth() })
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

// Shared by the account PATCH and the plan save (which carries debt terms).
function updateAccount(id: string, body: Record<string, unknown>): boolean {
  const account = db.prepare('SELECT source FROM accounts WHERE id = ?').get(id) as { source: string } | undefined
  if (!account) return false
  if (ACCOUNT_TYPES.includes(body.type as string)) db.prepare('UPDATE accounts SET type = ? WHERE id = ?').run(body.type as string, id)
  if ('apr' in body) db.prepare('UPDATE accounts SET apr = ? WHERE id = ?').run(optionalNumber(body.apr), id)
  if ('min_payment' in body) db.prepare('UPDATE accounts SET min_payment = ? WHERE id = ?').run(optionalNumber(body.min_payment), id)
  if ('in_plan' in body) db.prepare('UPDATE accounts SET in_plan = ? WHERE id = ?').run(body.in_plan ? 1 : 0, id)
  if ('promo_apr' in body) db.prepare('UPDATE accounts SET promo_apr = ? WHERE id = ?').run(optionalNumber(body.promo_apr), id)
  if ('promo_end' in body) {
    const end = typeof body.promo_end === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.promo_end) ? body.promo_end : null
    db.prepare('UPDATE accounts SET promo_end = ? WHERE id = ?').run(end, id)
  }
  if (account.source === 'manual' && body.balance != null) {
    const balance = Number(body.balance) || 0
    db.prepare('UPDATE accounts SET balance = ?, balance_date = ?, updated_at = ? WHERE id = ?').run(balance, today(), new Date().toISOString(), id)
    db.prepare('INSERT OR REPLACE INTO balance_snapshots (date, account_id, balance) VALUES (?, ?, ?)').run(today(), id, balance)
  }
  return true
}

app.patch('/api/accounts/:id', (req, res) => {
  if (!updateAccount(req.params.id, req.body ?? {})) return res.status(404).json({ error: 'No such account' })
  res.json({ ok: true })
})

app.delete('/api/accounts/:id', (req, res) => {
  db.exec('BEGIN')
  db.prepare('DELETE FROM splits WHERE transaction_id IN (SELECT id FROM transactions WHERE account_id = ?)').run(req.params.id)
  db.prepare('DELETE FROM transactions WHERE account_id = ?').run(req.params.id)
  db.prepare('DELETE FROM balance_snapshots WHERE account_id = ?').run(req.params.id)
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id)
  db.exec('COMMIT')
  res.json({ ok: true })
})

// CSV rows arrive already parsed by the browser: {date: 'YYYY-MM-DD', description, amount}
// with amount > 0 = money out. Ids are derived from the row contents, so
// importing the same file twice adds nothing the second time.
app.post('/api/accounts/:id/import', (req, res) => {
  const accountId = req.params.id
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) return res.status(404).json({ error: 'No such account' })
  const rows = Array.isArray(req.body.rows) ? req.body.rows : []
  const rule = db.prepare('SELECT category_id FROM rules WHERE pattern = ?')
  const insert = db.prepare(`
    INSERT OR IGNORE INTO transactions (id, account_id, date, name, merchant, amount, pending, category_id, category_source)
    VALUES (?, ?, ?, ?, NULL, ?, 0, ?, ?)`)
  const fallback = categoryIdByName('Other')
  const seen = new Map<string, number>()
  let added = 0
  let invalid = 0
  db.exec('BEGIN')
  try {
    for (const r of rows) {
      const date = String(r.date ?? '')
      const description = String(r.description ?? '').trim()
      const amount = Math.round(Number(r.amount) * 100) / 100
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !description || !Number.isFinite(amount) || amount === 0) {
        invalid++
        continue
      }
      const key = `${accountId}|${date}|${amount}|${description}`
      const n = (seen.get(key) ?? 0) + 1
      seen.set(key, n)
      const id = `csv-${crypto.createHash('sha1').update(`${key}|${n}`).digest('hex').slice(0, 24)}`
      const hit = rule.get(description.toLowerCase()) as { category_id: number } | undefined
      added += Number(insert.run(id, accountId, date, description, amount, hit?.category_id ?? fallback, hit ? 'rule' : 'none').changes)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  categorizeWithAi().catch((err) => console.error('Categorizing imported rows failed:', err.message))
  res.json({ added, duplicates: rows.length - added - invalid, invalid })
})

app.get('/api/categories', (_req, res) => {
  res.json(db.prepare('SELECT id, name, kind, track FROM categories ORDER BY kind, name').all())
})

app.post('/api/categories', (req, res) => {
  const kind = ['expense', 'income', 'savings', 'transfer'].includes(req.body.kind) ? req.body.kind : 'expense'
  const info = db.prepare('INSERT INTO categories (name, kind) VALUES (?, ?)').run(String(req.body.name).trim(), kind)
  res.json({ id: info.lastInsertRowid })
})

app.patch('/api/categories/:id', (req, res) => {
  if ('track' in req.body) db.prepare('UPDATE categories SET track = ? WHERE id = ?').run(req.body.track ? 1 : 0, Number(req.params.id))
  res.json({ ok: true })
})

app.get('/api/transactions', (req, res) => {
  const where: string[] = []
  const params: (string | number)[] = []
  if (req.query.month) { where.push('substr(t.date, 1, 7) = ?'); params.push(String(req.query.month)) }
  if (req.query.category) {
    where.push('(t.category_id = ? OR EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id AND s.category_id = ?))')
    params.push(Number(req.query.category), Number(req.query.category))
  }
  if (req.query.account) { where.push('t.account_id = ?'); params.push(String(req.query.account)) }
  if (req.query.q) {
    where.push('(t.name LIKE ? OR t.merchant LIKE ? OR t.notes LIKE ?)')
    params.push(`%${req.query.q}%`, `%${req.query.q}%`, `%${req.query.q}%`)
  }
  const rows = db.prepare(`
    SELECT t.id, t.date, t.name, t.merchant, t.amount, t.pending, t.category_id, t.category_source, t.notes, a.name AS account_name
    FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY t.date DESC, t.id LIMIT 1000`).all(...params) as any[]
  const splits = new Map<string, unknown[]>()
  for (const s of db.prepare('SELECT id, transaction_id, amount, category_id FROM splits ORDER BY id').all() as any[]) {
    if (!splits.has(s.transaction_id)) splits.set(s.transaction_id, [])
    splits.get(s.transaction_id)!.push(s)
  }
  res.json(rows.map((r) => ({ ...r, splits: splits.get(r.id) ?? [] })))
})

app.patch('/api/transactions/:id', (req, res) => {
  const id = req.params.id
  if ('notes' in req.body) db.prepare('UPDATE transactions SET notes = ? WHERE id = ?').run(String(req.body.notes ?? '').trim() || null, id)
  let alsoUpdated = 0
  if (req.body.category_id != null) {
    const categoryId = Number(req.body.category_id)
    db.prepare(`UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?`).run(categoryId, id)
    if (req.body.remember) {
      const t = db.prepare('SELECT COALESCE(merchant, name) AS label FROM transactions WHERE id = ?').get(id) as { label: string }
      const pattern = t.label.toLowerCase()
      db.prepare('INSERT OR REPLACE INTO rules (pattern, category_id) VALUES (?, ?)').run(pattern, categoryId)
      alsoUpdated = Number(db.prepare(`
        UPDATE transactions SET category_id = ?, category_source = 'rule'
        WHERE lower(COALESCE(merchant, name)) = ? AND category_source != 'user'`).run(categoryId, pattern).changes)
    }
  }
  res.json({ ok: true, alsoUpdated })
})

// Replace a transaction's split parts; an empty list removes the split.
app.put('/api/transactions/:id/splits', (req, res) => {
  const id = req.params.id
  const t = db.prepare('SELECT amount, pending FROM transactions WHERE id = ?').get(id) as { amount: number; pending: number } | undefined
  if (!t) return res.status(404).json({ error: 'No such transaction' })
  const parts = (Array.isArray(req.body.splits) ? req.body.splits : []).map((p: any) => ({
    category_id: Number(p.category_id),
    amount: Math.round(Number(p.amount) * 100) / 100,
  })) as { category_id: number; amount: number }[]
  if (parts.length) {
    if (t.pending) return res.status(400).json({ error: "Pending transactions can't be split until they post." })
    if (parts.length < 2 || parts.some((p) => !p.category_id || !p.amount || Math.sign(p.amount) !== Math.sign(t.amount))) {
      return res.status(400).json({ error: 'A split needs at least two parts, each with a category and an amount.' })
    }
    const total = Math.round(parts.reduce((s, p) => s + p.amount, 0) * 100) / 100
    if (Math.abs(total - t.amount) > 0.005) return res.status(400).json({ error: `Parts add up to ${total.toFixed(2)}, not ${t.amount.toFixed(2)}.` })
  }
  db.exec('BEGIN')
  db.prepare('DELETE FROM splits WHERE transaction_id = ?').run(id)
  const insert = db.prepare('INSERT INTO splits (transaction_id, amount, category_id) VALUES (?, ?, ?)')
  for (const p of parts) insert.run(id, p.amount, p.category_id)
  if (parts.length) db.prepare(`UPDATE transactions SET category_source = 'user' WHERE id = ?`).run(id)
  db.exec('COMMIT')
  res.json({ ok: true })
})

// Body: {image: base64 JPEG/PNG without the data: prefix, media_type}.
// Returns a proposed split; the browser shows it for confirmation.
app.post('/api/transactions/:id/receipt', async (req, res) => {
  const mediaType = String(req.body.media_type || 'image/jpeg')
  const data = String(req.body.image || '')
  if (!data || !/^image\/(jpeg|png|webp|gif)$/.test(mediaType)) return res.status(400).json({ error: 'Send a JPEG or PNG photo.' })
  res.json(await readReceipt(req.params.id, { data, mediaType }))
})

// Merchant rules created from the "remember" prompt in the Transactions tab.
app.get('/api/rules', (_req, res) => {
  res.json(db.prepare(`SELECT r.pattern, r.category_id, c.name AS category FROM rules r JOIN categories c ON c.id = r.category_id ORDER BY r.pattern`).all())
})

app.delete('/api/rules/:pattern', (req, res) => {
  db.prepare('DELETE FROM rules WHERE pattern = ?').run(req.params.pattern)
  res.json({ ok: true })
})

app.get('/api/budget', (req, res) => {
  res.json(budgetRows(String(req.query.month || currentMonth())))
})

app.put('/api/budget/:categoryId', (req, res) => {
  const amount = Number(req.body.amount) || 0
  if (amount > 0) db.prepare('INSERT OR REPLACE INTO budgets (category_id, amount) VALUES (?, ?)').run(Number(req.params.categoryId), amount)
  else db.prepare('DELETE FROM budgets WHERE category_id = ?').run(Number(req.params.categoryId))
  res.json({ ok: true })
})

// Sets a target for every expense category that has none, from its 3-month
// average rounded up to the next $10. Existing targets are left alone.
app.post('/api/budget/fill', (req, res) => {
  const put = db.prepare('INSERT OR REPLACE INTO budgets (category_id, amount) VALUES (?, ?)')
  let filled = 0
  for (const r of budgetRows(String(req.body.month || currentMonth()))) {
    if (r.kind !== 'expense' || r.budget > 0 || r.avg3 <= 0) continue
    put.run(r.id, Math.ceil(r.avg3 / 10) * 10)
    filled++
  }
  res.json({ filled })
})

app.get('/api/networth', (_req, res) => {
  res.json(db.prepare(`
    SELECT date,
      SUM(CASE WHEN balance > 0 THEN balance ELSE 0 END) AS assets,
      SUM(CASE WHEN balance < 0 THEN -balance ELSE 0 END) AS debts
    FROM balance_snapshots GROUP BY date ORDER BY date`).all())
})

// Income vs spending per month. Card charges count as spending when made; card
// payments are transfers. debtEnd is total owed at the month's last snapshot.
app.get('/api/cashflow', (req, res) => {
  const months = Math.min(24, Number(req.query.months) || 12)
  const from = addMonths(currentMonth(), -(months - 1))
  const flows = db.prepare(`
    SELECT substr(l.date, 1, 7) AS month,
      ROUND(-SUM(CASE WHEN c.kind = 'income' THEN l.amount ELSE 0 END), 2) AS income,
      ROUND(SUM(CASE WHEN c.kind = 'expense' THEN l.amount ELSE 0 END), 2) AS spending,
      ROUND(SUM(CASE WHEN c.name = 'Debt Payments' THEN l.amount ELSE 0 END), 2) AS debtPayments
    FROM ledger l JOIN categories c ON c.id = l.category_id
    WHERE l.pending = 0 AND substr(l.date, 1, 7) >= ?
    GROUP BY 1 ORDER BY 1`).all(from) as any[]
  const debt = db.prepare(`
    SELECT substr(s.date, 1, 7) AS month, SUM(CASE WHEN s.balance < 0 THEN -s.balance ELSE 0 END) AS owed
    FROM balance_snapshots s
    WHERE s.date = (SELECT MAX(date) FROM balance_snapshots WHERE substr(date, 1, 7) = substr(s.date, 1, 7))
    GROUP BY 1`).all() as { month: string; owed: number }[]
  const owed = new Map(debt.map((d) => [d.month, d.owed]))
  res.json(flows.map((f) => ({ ...f, net: Math.round((f.income - f.spending) * 100) / 100, debtEnd: owed.get(f.month) ?? null })))
})

// Running totals for categories marked "track" (e.g. Legal).
app.get('/api/tracked', (req, res) => {
  const month = String(req.query.month || currentMonth())
  res.json(db.prepare(`
    SELECT c.id, c.name, ROUND(SUM(l.amount), 2) AS total, MIN(l.date) AS since,
      ROUND(SUM(CASE WHEN substr(l.date, 1, 7) = ? THEN l.amount ELSE 0 END), 2) AS thisMonth
    FROM categories c JOIN ledger l ON l.category_id = c.id
    WHERE c.track = 1 AND l.pending = 0
    GROUP BY c.id ORDER BY c.name`).all(month))
})

app.get('/api/recurring', (_req, res) => {
  res.json({ items: detectRecurring(), ignored: ignoredRecurring(), cadences: CADENCES.map((c) => c.name) })
})

// Body: {key | label, status: 'yes' | 'no', cadence?}. From the Recurring page
// (key) or a transaction's "recurring" action (label = merchant).
app.put('/api/recurring', (req, res) => {
  setRecurringOverride(req.body ?? {})
  res.json({ ok: true })
})

app.delete('/api/recurring/:key', (req, res) => {
  clearRecurringOverride(req.params.key)
  res.json({ ok: true })
})

// plan_rank: position in the saved plan's payoff order (null if not in it).
app.get('/api/debts', (_req, res) => {
  const order = planDebtOrder()
  res.json(debtSummary().map((d) => ({ ...d, plan_rank: order.includes(d.id) ? order.indexOf(d.id) : null })))
})

app.get('/api/plan', (_req, res) => {
  res.json(planReport())
})

// Body: {plan, debts?: [{id, apr, promo_apr, promo_end, min_payment}]}.
app.put('/api/plan', (req, res) => {
  savePlan(req.body?.plan)
  const terms = Array.isArray(req.body?.debts) ? req.body.debts : []
  for (const t of terms) {
    if (typeof t?.id !== 'string') continue
    const { apr, promo_apr, promo_end, min_payment } = t
    updateAccount(t.id, { apr, promo_apr, promo_end, min_payment })
  }
  res.json(planReport())
})

app.delete('/api/plan', (_req, res) => {
  resetPlan()
  res.json(planReport())
})

// Reads a written plan with Claude and returns it as plan settings for the
// editor to show; nothing is saved until the user saves.
app.post('/api/plan/import', async (req, res) => {
  res.json(await importPlan(String(req.body?.text ?? '')))
})

// For the Daily Briefing add-on: ?generate=1 creates today's text if missing.
app.get('/api/briefing', async (req, res) => {
  let briefing = cachedBriefing()
  if (!briefing && req.query.generate && (await aiAvailable())) briefing = await generateBriefing()
  res.json({ briefing, data: briefingData() })
})

app.post('/api/briefing', async (_req, res) => {
  res.json({ briefing: await generateBriefing() })
})

// Compact snapshot for the Daily Briefing add-on and other HA consumers.
app.get('/api/summary', (_req, res) => {
  const month = currentMonth()
  const rows = budgetRows(month)
  const expenses = rows.filter((r) => r.kind === 'expense')
  const accounts = db.prepare('SELECT name, org_name, type, balance, balance_date FROM accounts ORDER BY type, name').all() as any[]
  const assets = accounts.reduce((s, a) => s + Math.max(0, a.balance ?? 0), 0)
  const debts = accounts.reduce((s, a) => s + Math.max(0, -(a.balance ?? 0)), 0)
  const in7 = new Date(Date.parse(today()) + 7 * 86400000).toISOString().slice(0, 10)
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
      FROM ledger t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.amount > 0 ORDER BY t.date DESC, t.amount DESC LIMIT 10`).all(),
    insight: (db.prepare('SELECT content FROM insights WHERE month = ?').get(month) as { content: string } | undefined)?.content ?? null,
    upcoming: detectRecurring()
      .filter((r) => !r.stopped && r.nextDate >= today() && r.nextDate <= in7)
      .map((r) => ({ merchant: r.merchant, amount: r.amount, due: r.nextDate })),
    issues: syncHealth().issues,
    briefing: cachedBriefing()?.text ?? null,
    plan: planBrief(),
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

function backup() {
  try {
    console.log(`Backed up database to ${backupDb()}`)
  } catch (err: any) {
    console.error('Backup failed:', err.message)
  }
}

// Once a day: sync (SimpleFIN allows ~24 requests a day), write the daily
// briefing, then back up. At startup, only the parts that are overdue run.
const DAY_MS = 24 * 60 * 60 * 1000
const overdue = (key: string) => {
  const last = meta.get(key)
  return !last || Date.now() - Date.parse(last) > 20 * 60 * 60 * 1000
}
async function dailyJob() {
  if (isConnected()) await syncAndCategorize().catch((err) => console.error('Scheduled sync failed:', err.message))
  if (await aiAvailable()) await generateBriefing().catch((err) => console.error('Briefing failed:', err.message))
  backup()
}
setInterval(dailyJob, DAY_MS)
async function startup() {
  if (!isConnected() && config.simplefinSetupToken) {
    try {
      await claimSetupToken(config.simplefinSetupToken)
      console.log('Claimed SimpleFIN setup token')
    } catch (err: any) {
      console.error('SimpleFIN setup token claim failed:', err.message)
    }
  }
  if (overdue('last_sync')) await dailyJob()
  else if (overdue('last_backup')) backup()
}
startup()
