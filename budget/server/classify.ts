import { categoryIdByName, db } from './db.ts'

// High-confidence keyword rules that don't need the AI. Each is checked
// against the lowercased payee + description, optionally limited to an
// account type. First match wins; the AI only sees what's left.
type Rule = { match: RegExp; category: string; accountTypes?: string[]; direction?: 'in' | 'out' }
const RULES: Rule[] = [
  { match: /aj monitoring|idea forum|thorto|jeff ?co\b|jefferson county/, category: 'Legal', direction: 'out' },
  { match: /payroll|direct dep|salary/, category: 'Income', accountTypes: ['depository'], direction: 'in' },
  { match: /contribution|partic contr/, category: '401k Contribution', accountTypes: ['investment'], direction: 'in' },
  { match: /dividend|reinvestment|core account|cash reserves|money market|redemption from core|purchase into core/, category: 'Investment Activity', accountTypes: ['investment'] },
  { match: /mortgage|mtg /, category: 'Housing', accountTypes: ['depository'], direction: 'out' },
  { match: /credit card|card payment|autopay|payment thank you|online payment/, category: 'Transfer', accountTypes: ['depository'], direction: 'out' },
  { match: /payment|pymt/, category: 'Transfer', accountTypes: ['credit', 'loan'], direction: 'in' },
  { match: /venmo|zelle|internet transfer|round up transfer|transfer to|transfer from/, category: 'Transfer' },
  { match: /lightstream|loan pay/, category: 'Debt Payments', accountTypes: ['depository'], direction: 'out' },
]

function builtinCategory(text: string, amount: number, accountType: string, accountName: string): string | null {
  const t = text.toLowerCase()
  const hsa = /hsa|health savings/i.test(accountName)
  for (const r of RULES) {
    if (r.accountTypes && !r.accountTypes.includes(accountType)) continue
    if (r.direction === 'in' && amount >= 0) continue
    if (r.direction === 'out' && amount <= 0) continue
    if (!r.match.test(t)) continue
    return r.category === '401k Contribution' && hsa ? 'HSA Contribution' : r.category
  }
  return null
}

// Applies the built-in rules to transactions nobody has categorized yet.
export function applyBuiltinRules(): number {
  const rows = db.prepare(`
    SELECT t.id, t.name, t.merchant, t.amount, a.type AS account_type, a.name AS account_name
    FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.category_source = 'none'`).all() as any[]
  const update = db.prepare(`UPDATE transactions SET category_id = ?, category_source = 'rule' WHERE id = ?`)
  let n = 0
  db.exec('BEGIN')
  for (const r of rows) {
    const name = builtinCategory(`${r.merchant ?? ''} ${r.name ?? ''}`, r.amount, r.account_type, r.account_name)
    const id = name ? categoryIdByName(name) : null
    if (id) {
      update.run(id, r.id)
      n++
    }
  }
  db.exec('COMMIT')
  return n
}
