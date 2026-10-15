import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.ts'

const dbPath = path.join(config.dataDir, 'budget.db')

// Nightly copies live in the add-on's config folder, outside /data, so a
// reinstall that starts with an empty /data picks up from the latest one.
function backupFiles(): string[] {
  if (!fs.existsSync(config.backupDir)) return []
  return fs.readdirSync(config.backupDir).filter((f) => /^budget-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort()
}

if (!fs.existsSync(dbPath)) {
  const latest = backupFiles().at(-1)
  if (latest) {
    fs.copyFileSync(path.join(config.backupDir, latest), dbPath)
    console.log(`Restored budget.db from backup ${latest}`)
  }
}

export const db = new DatabaseSync(dbPath)
// WAL with normal sync keeps writes cheap on the HA Green's eMMC.
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL')

// Conventions: transactions.amount > 0 is money leaving the account.
// accounts.balance is signed as the bank reports it: negative = owed.
db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'simplefin', -- simplefin | manual
  org_name TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'depository', -- depository | credit | loan | investment | other
  balance REAL,
  available REAL,
  currency TEXT DEFAULT 'USD',
  balance_date TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL DEFAULT 'expense' -- expense | income | savings | transfer
);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  date TEXT NOT NULL,
  name TEXT,
  merchant TEXT,
  amount REAL NOT NULL,
  pending INTEGER NOT NULL DEFAULT 0,
  category_id INTEGER,
  category_source TEXT NOT NULL DEFAULT 'none', -- none | rule | ai | user
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);
-- A split transaction is replaced by its parts everywhere totals are taken
-- (see the ledger view). Parts carry the parent's sign and sum to its amount.
CREATE TABLE IF NOT EXISTS splits (
  id INTEGER PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  amount REAL NOT NULL,
  category_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_splits_transaction ON splits(transaction_id);
-- The user's corrections to recurring detection, keyed by normalized merchant.
-- status 'yes' = definitely recurring (cadence optional), 'no' = never show.
CREATE TABLE IF NOT EXISTS recurring_overrides (
  merchant_key TEXT PRIMARY KEY,
  label TEXT,
  status TEXT NOT NULL,
  cadence TEXT
);
CREATE TABLE IF NOT EXISTS budgets (
  category_id INTEGER PRIMARY KEY,
  amount REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS rules (
  pattern TEXT PRIMARY KEY, -- lowercased payee/description
  category_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS balance_snapshots (
  date TEXT NOT NULL,
  account_id TEXT NOT NULL,
  balance REAL,
  PRIMARY KEY (date, account_id)
);
CREATE TABLE IF NOT EXISTS insights (
  month TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`)

function addColumn(table: string, column: string, definition: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (columns.some((c) => c.name === column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  return true
}
// Debt plan inputs: APR in percent, minimum monthly payment, include in payoff plan.
addColumn('accounts', 'apr', 'REAL')
addColumn('accounts', 'min_payment', 'REAL')
addColumn('accounts', 'in_plan', 'INTEGER NOT NULL DEFAULT 1')
// Promotional rate (e.g. 0% on a card) that applies until promo_end (YYYY-MM-DD).
addColumn('accounts', 'promo_apr', 'REAL')
addColumn('accounts', 'promo_end', 'TEXT')
// Tracked categories get their own running-total card on the dashboard.
const trackAdded = addColumn('categories', 'track', 'INTEGER NOT NULL DEFAULT 0')

// Every total (budget, cash flow, insights, recurring) reads this view, so
// a split transaction counts once per part and never as its parent.
db.exec(`
DROP VIEW IF EXISTS ledger;
CREATE VIEW ledger AS
  SELECT t.id, t.id AS transaction_id, t.account_id, t.date, t.name, t.merchant, t.amount, t.pending,
    t.category_id, t.category_source, t.notes
  FROM transactions t WHERE NOT EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id)
  UNION ALL
  SELECT t.id || '#' || s.id, t.id, t.account_id, t.date, t.name, t.merchant, s.amount, t.pending,
    s.category_id, 'user', t.notes
  FROM splits s JOIN transactions t ON t.id = s.transaction_id;
`)

export const meta = {
  get: (key: string): string | null =>
    (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null,
  set: (key: string, value: string) => db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value),
  delete: (key: string) => db.prepare('DELETE FROM meta WHERE key = ?').run(key),
}

// The SimpleFIN access URL (it embeds credentials) lives in a separate file
// so the read-only query connection used by AI features can never see it.
// It is deliberately not backed up.
export const secrets = new DatabaseSync(path.join(config.dataDir, 'secrets.db'))
secrets.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
export const secret = {
  get: (key: string): string | null =>
    (secrets.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null,
  set: (key: string, value: string) => secrets.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, value),
  delete: (key: string) => secrets.prepare('DELETE FROM kv WHERE key = ?').run(key),
}

const SEED_CATEGORIES: [string, string][] = [
  ['Income', 'income'],
  ['Transfer', 'transfer'],
  ['401k Contribution', 'savings'],
  ['HSA Contribution', 'savings'],
  ['Investment Activity', 'savings'],
  ['Debt Payments', 'expense'],
  ['Housing', 'expense'],
  ['Utilities', 'expense'],
  ['Groceries', 'expense'],
  ['Dining', 'expense'],
  ['Transportation', 'expense'],
  ['Shopping', 'expense'],
  ['Home', 'expense'],
  ['Health', 'expense'],
  ['Personal Care', 'expense'],
  ['Entertainment', 'expense'],
  ['Subscriptions', 'expense'],
  ['Insurance', 'expense'],
  ['Travel', 'expense'],
  ['Services', 'expense'],
  ['Taxes & Giving', 'expense'],
  ['Fees', 'expense'],
  ['Legal', 'expense'],
  ['Other', 'expense'],
]
const seed = db.prepare('INSERT OR IGNORE INTO categories (name, kind) VALUES (?, ?)')
for (const [name, kind] of SEED_CATEGORIES) seed.run(name, kind)
if (trackAdded) db.prepare(`UPDATE categories SET track = 1 WHERE name = 'Legal'`).run()

export function categoryIdByName(name: string): number | null {
  const row = db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number } | undefined
  return row?.id ?? null
}

// One consistent copy per day (VACUUM INTO), keeping the last week.
export function backupDb(): string {
  fs.mkdirSync(config.backupDir, { recursive: true })
  const file = path.join(config.backupDir, `budget-${new Date().toISOString().slice(0, 10)}.db`)
  fs.rmSync(file, { force: true })
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
  for (const old of backupFiles().slice(0, -7)) fs.rmSync(path.join(config.backupDir, old), { force: true })
  meta.set('last_backup', new Date().toISOString())
  return file
}

// Separate read-only connection for model-written and user-written SQL.
const readDb = new DatabaseSync(dbPath, { readOnly: true })

export function runReadOnly(sql: string, maxRows = 500): unknown[] {
  const trimmed = sql.trim().replace(/;+\s*$/, '')
  if (!/^(select|with)\b/i.test(trimmed) || trimmed.includes(';')) {
    throw new Error('Only a single SELECT statement is allowed')
  }
  return readDb.prepare(trimmed).all().slice(0, maxRows)
}

export const SCHEMA_DOC = `SQLite tables and views:
ledger(id, transaction_id, account_id, date 'YYYY-MM-DD', name, merchant, amount, pending 0/1, category_id, category_source, notes)
  USE THIS for any totals or category questions: it is the transactions table with split transactions replaced by their parts.
  amount > 0 is money spent/leaving the account; amount < 0 is money received (income, refunds).
transactions(id, account_id, date, name, merchant, amount, pending, category_id, category_source, notes)  raw rows; split parents still appear here.
splits(id, transaction_id, amount, category_id)  parts of a split transaction.
accounts(id, source, org_name, name, type, balance, available, currency, balance_date, apr, min_payment, in_plan, promo_apr, promo_end)
  type is depository | credit | loan | investment | other. balance is signed: negative means money owed (credit cards, loans, mortgage). apr is percent; promo_apr applies until promo_end.
categories(id, name, kind, track)  kind is expense | income | savings | transfer. Only kind='expense' counts as spending. 'savings' is pre-tax 401k/HSA contributions and investment activity (dividends, sweeps) inside investment accounts.
budgets(category_id, amount)  monthly target per category.
balance_snapshots(date, account_id, balance)  one row per account per day synced (signed like accounts.balance).`
