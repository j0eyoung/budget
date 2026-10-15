import { askClaude } from './claude.ts'
import { db, meta } from './db.ts'
import { syncHealth } from './health.ts'
import { planBrief } from './plan.ts'
import { budgetRows, currentMonth, today } from './queries.ts'
import { detectRecurring } from './recurring.ts'

// Daily "anything to flag today?" check, for the dashboard and the Daily
// Briefing add-on. Generated once a day after the sync and cached.

export type Briefing = { date: string; text: string; createdAt: string }

export function briefingData() {
  const date = today()
  const month = currentMonth()
  const rows = budgetRows(month).filter((r) => r.kind === 'expense')
  const [y, m, d] = date.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const in7 = new Date(Date.parse(date) + 7 * 86400000).toISOString().slice(0, 10)
  const recurring = detectRecurring()
  return {
    date,
    monthElapsed: Math.round((d / daysInMonth) * 100) / 100,
    spentThisMonth: Math.round(rows.reduce((s, r) => s + r.spent, 0)),
    budgetedThisMonth: rows.reduce((s, r) => s + r.budget, 0),
    overOrPacingOver: rows
      .filter((r) => r.budget > 0 && r.spent > r.budget * Math.max(0.5, d / daysInMonth))
      .map((r) => ({ category: r.name, spent: Math.round(r.spent), budget: r.budget })),
    recentCharges: db.prepare(`
      SELECT l.date, COALESCE(l.merchant, l.name) AS merchant, l.amount, c.name AS category, a.name AS account
      FROM ledger l JOIN categories c ON c.id = l.category_id LEFT JOIN accounts a ON a.id = l.account_id
      WHERE c.kind = 'expense' AND l.amount > 0 AND l.date >= date('now', '-3 days')
      ORDER BY l.amount DESC LIMIT 15`).all(),
    billsDueThisWeek: recurring
      .filter((r) => !r.stopped && r.nextDate >= date && r.nextDate <= in7)
      .map((r) => ({ merchant: r.merchant, amount: r.amount, due: r.nextDate })),
    priceIncreases: recurring.filter((r) => r.increase && !r.stopped).map((r) => ({ merchant: r.merchant, ...r.increase })),
    connectionIssues: syncHealth().issues,
    plan: planBrief(),
  }
}

export async function generateBriefing(): Promise<Briefing> {
  const data = briefingData()
  const text = (await askClaude(`You write a short morning money check for one person. Using only the data below, list up to 4 things worth their attention today, one per line starting with "- ", plain text, specific dollar amounts. Worth flagging: unusually large recent charges, bills due in the next few days, price increases, categories over budget or pacing to go over (monthElapsed is the fraction of the month gone), broken account connections. From their payoff plan (plan): a bonus or third paycheck that just landed and the goal the plan sends it to (plan.windfalls), new charges in the last few days on the card they're paying off (plan.focus.recentCharges), and plan.warnings only if nothing more pressing. Do not give investment advice. If nothing stands out, reply exactly: Nothing to flag today.

${JSON.stringify(data)}`)).trim()
  const briefing = { date: data.date, text, createdAt: new Date().toISOString() }
  meta.set('briefing', JSON.stringify(briefing))
  return briefing
}

export function cachedBriefing(): Briefing | null {
  const b = JSON.parse(meta.get('briefing') || 'null') as Briefing | null
  return b && b.date === today() ? b : null
}
