import { askClaudeWithImage } from './claude.ts'
import { db } from './db.ts'

// Reads a receipt photo and proposes how to split the bank charge across
// categories. Nothing is saved here: the browser shows the proposal in the
// split editor and the user confirms. The photo itself is never stored.

type Group = { category: string; amount: number; items?: string[] }
export type ReceiptProposal = {
  parts: { category_id: number; category: string; amount: number; items: string[] }[]
  receiptTotal: number | null
  mismatch: boolean
  summary: string
}

export async function readReceipt(transactionId: string, image: { data: string; mediaType: string }): Promise<ReceiptProposal> {
  const t = db.prepare('SELECT date, name, merchant, amount, pending FROM transactions WHERE id = ?').get(transactionId) as
    | { date: string; name: string; merchant: string | null; amount: number; pending: number }
    | undefined
  if (!t) throw new Error('No such transaction')
  if (t.amount <= 0) throw new Error('Receipts can only be matched to purchases.')
  const categories = db.prepare(`SELECT id, name FROM categories WHERE kind = 'expense' ORDER BY name`).all() as { id: number; name: string }[]

  const reply = await askClaudeWithImage(`This photo should be a store receipt for a purchase at ${t.merchant || t.name} on ${t.date}. The bank charged $${t.amount.toFixed(2)}.
Group the receipt's line items into budget categories, using only these names: ${categories.map((c) => c.name).join(', ')}.
Prescriptions, pharmacy, medicine, first aid and vitamins are "Health". Food and everyday household supplies are "Groceries". Fuel is "Transportation". Clothing, electronics and general merchandise are "Shopping".
Spread tax, fees and discounts across the groups in proportion to their amounts so the groups add up to the receipt total.
Reply with only JSON, no other text:
{"readable": true, "receipt_total": <number or null>, "groups": [{"category": "<one name from the list>", "amount": <number>, "items": ["<short item name>", ...]}]}
If the photo is not a readable receipt, reply {"readable": false}.`, image)

  const cleaned = reply.replace(/```(?:json)?/g, '').trim()
  let parsed: { readable?: boolean; receipt_total?: number | null; groups?: Group[] }
  try {
    parsed = JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1))
  } catch {
    throw new Error("Couldn't read the receipt. Try a sharper, flatter photo.")
  }
  if (!parsed.readable || !parsed.groups?.length) throw new Error("That photo doesn't look like a readable receipt.")

  // Merge duplicate categories and map names to ids; anything unknown is Other.
  const byName = new Map(categories.map((c) => [c.name.toLowerCase(), c]))
  const other = byName.get('other')!
  const merged = new Map<number, { category_id: number; category: string; amount: number; items: string[] }>()
  for (const g of parsed.groups) {
    const c = byName.get(String(g.category).toLowerCase()) ?? other
    const amount = Number(g.amount) || 0
    if (amount <= 0) continue
    const m = merged.get(c.id) ?? { category_id: c.id, category: c.name, amount: 0, items: [] }
    m.amount += amount
    m.items.push(...(g.items ?? []).map(String))
    merged.set(c.id, m)
  }
  const parts = [...merged.values()].sort((a, b) => b.amount - a.amount)
  if (!parts.length) throw new Error("Couldn't find any items on that receipt.")

  // Scale to the bank amount (cash back, tips or a misread total would
  // otherwise leave the split unbalanced) and put rounding on the largest part.
  const sum = parts.reduce((s, p) => s + p.amount, 0)
  for (const p of parts) p.amount = Math.round(((p.amount * t.amount) / sum) * 100) / 100
  const drift = Math.round((t.amount - parts.reduce((s, p) => s + p.amount, 0)) * 100) / 100
  parts[0].amount = Math.round((parts[0].amount + drift) * 100) / 100

  const receiptTotal = parsed.receipt_total != null && Number.isFinite(Number(parsed.receipt_total)) ? Number(parsed.receipt_total) : null
  const summary = `Receipt: ${parts
    .map((p) => `${p.category} $${p.amount.toFixed(2)}${p.items.length ? ` (${p.items.slice(0, 4).join(', ')}${p.items.length > 4 ? ', …' : ''})` : ''}`)
    .join('; ')}`.slice(0, 300)
  return {
    parts,
    receiptTotal,
    mismatch: receiptTotal != null && Math.abs(receiptTotal - t.amount) > 1,
    summary,
  }
}
