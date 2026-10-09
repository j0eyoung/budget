import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.ts'

const dbPath = path.join(config.dataDir, 'budget.db')

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

export const meta = {
  get: (key: string): string | null =>
    (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null,
  set: (key: string, value: string) => db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value),
}

// The SimpleFIN access URL (it embeds credentials) lives in a separate file
// so the read-only query connection used by AI features can never see it.
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

export function categoryIdByName(name: string): number | null {
  const row = db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number } | undefined
  return row?.id ?? null
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

export const SCHEMA_DOC = `SQLite tables:
accounts(id, source, org_name, name, type, balance, available, currency, balance_date)
  type is depository | credit | loan | investment | other. balance is signed: negative means money owed (credit cards, loans, mortgage).
transactions(id, account_id, date 'YYYY-MM-DD', name, merchant, amount, pending 0/1, category_id, category_source, notes)
  amount > 0 is money spent/leaving the account; amount < 0 is money received (income, refunds).
categories(id, name, kind)  kind is expense | income | savings | transfer. Only kind='expense' counts as spending. 'savings' is pre-tax 401k/HSA contributions and investment activity (dividends, sweeps) inside investment accounts.
budgets(category_id, amount)  monthly target per category.
balance_snapshots(date, account_id, balance)  one row per account per day synced (signed like accounts.balance).`
