import { askClaude, available } from './claude.ts'
import { applyBuiltinRules } from './classify.ts'
import { SCHEMA_DOC, db, runReadOnly } from './db.ts'

export const aiAvailable = available

// Pulls the first JSON value out of a reply that may be wrapped in prose or a code fence.
function parseJson(text: string): any {
  const cleaned = text.replace(/```(?:json)?/g, '').trim()
  const start = cleaned.search(/[[{]/)
  if (start < 0) throw new Error('Claude did not return JSON')
  return JSON.parse(cleaned.slice(start, Math.max(cleaned.lastIndexOf(']'), cleaned.lastIndexOf('}')) + 1))
}

type PendingRow = { id: string; name: string; merchant: string | null; amount: number; account: string; account_type: string }

// Labels transactions that only have the default category. Built-in keyword
// rules go first; Claude sees description, amount and account for the rest.
export async function categorizeWithAi(maxTransactions = 200): Promise<number> {
  const builtin = applyBuiltinRules()
  if (!(await available())) return builtin
  const categories = db.prepare('SELECT id, name FROM categories').all() as { id: number; name: string }[]
  const byName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]))
  const rows = db
    .prepare(`SELECT t.id, t.name, t.merchant, t.amount, a.name AS account, a.type AS account_type
      FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.category_source = 'none' ORDER BY t.date DESC LIMIT ?`)
    .all(maxTransactions) as PendingRow[]
  const update = db.prepare(`UPDATE transactions SET category_id = COALESCE(?, category_id), category_source = 'ai' WHERE id = ?`)

  let done = 0
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100)
    const prompt = `Categorize these bank transactions for a personal budget.
Allowed categories: ${categories.map((c) => c.name).join(', ')}.
Positive amounts are money leaving the account, negative amounts are money arriving.
Rules:
- Payroll deposits into checking are "Income".
- Moves between the user's own accounts, Venmo/Zelle cash-outs, and payments RECEIVED by a credit card or loan account are "Transfer".
- Credit card payments SENT from checking are "Transfer". Loan payments sent from checking are "Debt Payments"; mortgage payments are "Housing".
- Inside a 401k account, contributions are "401k Contribution". Inside an HSA account, employee/participant contributions are "HSA Contribution".
- Dividends, reinvestments, and core/money-market sweeps inside investment or HSA accounts are "Investment Activity".
- Debit card purchases from an HSA are normal spending (usually "Health").
- Court, probation, monitoring, county government and attorney payments are "Legal".
Reply with only a JSON array of {"i": <index>, "category": "<one allowed category>"}, one entry per transaction, no other text.

${JSON.stringify(batch.map((t, idx) => ({ i: idx, description: t.merchant || t.name, raw: t.name, amount: t.amount, account: `${t.account} (${t.account_type})` })))}`
    const result = parseJson(await askClaude(prompt)) as { i: number; category: string }[]
    for (const r of result) {
      const t = batch[r.i]
      if (!t) continue
      update.run(byName.get(String(r.category).toLowerCase()) ?? null, t.id)
      done++
    }
  }
  return done + builtin
}

export async function ask(question: string): Promise<{ answer: string; sql: string; rows: unknown[] }> {
  const today = new Date().toISOString().slice(0, 10)
  const base = `You write SQLite queries over a personal finance database.
${SCHEMA_DOC}
Today is ${today}.
Reply with only JSON {"sql": "<one SELECT statement>"} that fetches what is needed to answer the question. Join categories for names. Limit to 100 rows.

Question: ${question}`

  let sql = ''
  let rows: unknown[] = []
  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = lastError ? `${base}\n\nYour previous query "${sql}" failed with: ${lastError}. Fix it.` : base
    sql = String(parseJson(await askClaude(prompt)).sql ?? '')
    try {
      rows = runReadOnly(sql, 100)
      lastError = ''
      break
    } catch (err: any) {
      lastError = err.message
    }
  }
  if (lastError) throw new Error(`Could not build a working query: ${lastError}`)

  const answer = await askClaude(`Answer the user's personal finance question using only the query result below.
Be concise, use dollar amounts, plain text only (no markdown). If the result is empty, say no matching data was found.

Question: ${question}
SQL: ${sql}
Result: ${JSON.stringify(rows)}`)
  return { answer: answer.trim(), sql, rows }
}

function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7)
}

export async function generateInsights(month: string): Promise<string> {
  const byCategory = db.prepare(`
    SELECT c.name AS category, ROUND(SUM(t.amount), 2) AS spent, b.amount AS budget
    FROM transactions t JOIN categories c ON c.id = t.category_id LEFT JOIN budgets b ON b.category_id = c.id
    WHERE c.kind = 'expense' AND substr(t.date, 1, 7) = ? GROUP BY c.id ORDER BY spent DESC`)
  const sumKind = db.prepare(`
    SELECT ROUND(-SUM(t.amount), 2) AS total FROM transactions t JOIN categories c ON c.id = t.category_id
    WHERE c.kind = ? AND substr(t.date, 1, 7) = ?`)
  const data = {
    month,
    thisMonth: byCategory.all(month),
    lastMonth: byCategory.all(previousMonth(month)),
    income: sumKind.get('income', month),
    preTaxSavings: sumKind.get('savings', month),
    topMerchants: db.prepare(`
      SELECT COALESCE(t.merchant, t.name) AS merchant, COUNT(*) AS count, ROUND(SUM(t.amount), 2) AS total
      FROM transactions t JOIN categories c ON c.id = t.category_id
      WHERE c.kind = 'expense' AND substr(t.date, 1, 7) = ? GROUP BY 1 ORDER BY total DESC LIMIT 15`).all(month),
    largest: db.prepare(`
      SELECT t.date, COALESCE(t.merchant, t.name) AS merchant, t.amount, c.name AS category
      FROM transactions t JOIN categories c ON c.id = t.category_id
      WHERE c.kind = 'expense' AND substr(t.date, 1, 7) = ? ORDER BY t.amount DESC LIMIT 10`).all(month),
    debts: db.prepare(`SELECT name, type, -balance AS owed FROM accounts WHERE balance < 0`).all(),
  }
  const content = (await askClaude(`You are reviewing one month of a household's finances. Write a short review in plain text (no markdown):
a one-sentence summary, then 4 to 7 lines each starting with "- " covering where spending went over budget,
notable changes from last month, unusual or large charges, recurring subscriptions worth a look, and one practical suggestion.
Use specific dollar amounts from the data. Do not give investment advice.

${JSON.stringify(data)}`)).trim()
  db.prepare('INSERT OR REPLACE INTO insights (month, content, created_at) VALUES (?, ?, ?)').run(month, content, new Date().toISOString())
  return content
}
