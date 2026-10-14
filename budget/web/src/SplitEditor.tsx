import { useState } from 'react'
import { api, money } from './api.ts'
import type { Category, Transaction } from './api.ts'

type Part = { category_id: string; amount: string }

// What a receipt photo suggested: parts that already add up to the charge,
// plus a note summarizing the items.
export type Proposal = {
  parts: { category_id: number; amount: number }[]
  summary: string
  warning?: string
}

// Splits one bank line (e.g. a Costco trip) into parts with their own
// categories. The last part always takes whatever is left, so parts add up.
export function SplitEditor({ t, categories, proposal, onDone, onError }: {
  t: Transaction
  categories: Category[]
  proposal?: Proposal
  onDone: () => void
  onError: (message: string) => void
}) {
  const sign = t.amount < 0 ? -1 : 1
  const total = Math.abs(t.amount)
  const [parts, setParts] = useState<Part[]>(() =>
    proposal
      ? proposal.parts.map((p) => ({ category_id: String(p.category_id), amount: Math.abs(p.amount).toFixed(2) }))
      : t.splits.length
        ? t.splits.map((s) => ({ category_id: String(s.category_id), amount: Math.abs(s.amount).toFixed(2) }))
        : [{ category_id: String(t.category_id ?? ''), amount: '' }, { category_id: '', amount: '' }],
  )
  const [busy, setBusy] = useState(false)

  const fixed = parts.slice(0, -1)
  const remainder = Math.round((total - fixed.reduce((s, p) => s + (Number(p.amount) || 0), 0)) * 100) / 100
  const valid = parts.every((p) => p.category_id) && fixed.every((p) => Number(p.amount) > 0) && remainder > 0

  const update = (i: number, change: Partial<Part>) => setParts(parts.map((p, j) => (j === i ? { ...p, ...change } : p)))

  const save = async (splits: { category_id: number; amount: number }[]) => {
    setBusy(true)
    try {
      await api(`transactions/${encodeURIComponent(t.id)}/splits`, 'PUT', { splits })
      // Keep what the receipt said, unless there's already a note.
      if (proposal && splits.length && !t.notes) await api(`transactions/${encodeURIComponent(t.id)}`, 'PATCH', { notes: proposal.summary })
      onDone()
    } catch (e: any) {
      onError(e.message)
      setBusy(false)
    }
  }

  const submit = () =>
    save(parts.map((p, i) => ({
      category_id: Number(p.category_id),
      amount: sign * (i === parts.length - 1 ? remainder : Number(p.amount)),
    })))

  return (
    <div className="split-editor">
      <div className="muted">
        {proposal ? `From your receipt: check the split of ${money(total)} and save` : `Split ${money(total)} from ${t.merchant || t.name}`}
      </div>
      {proposal?.warning && <div className="over">{proposal.warning}</div>}
      {proposal && <div className="note">{proposal.summary}</div>}
      {parts.map((p, i) => {
        const last = i === parts.length - 1
        return (
          <div className="toolbar" key={i}>
            <select value={p.category_id} onChange={(e) => update(i, { category_id: e.target.value })}>
              <option value="">Category…</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {last ? (
              <span className={`split-rest num ${remainder <= 0 ? 'over' : ''}`}>{money(remainder)} (rest)</span>
            ) : (
              <input className="amount" type="number" min="0" step="0.01" placeholder="Amount" value={p.amount}
                onChange={(e) => update(i, { amount: e.target.value })} />
            )}
            {parts.length > 2 && (
              <button className="link" onClick={() => setParts(parts.filter((_, j) => j !== i))}>Remove</button>
            )}
          </div>
        )
      })}
      <div className="toolbar">
        <button onClick={() => setParts([...parts.slice(0, -1), { category_id: '', amount: '' }, parts.at(-1)!])}>Add part</button>
        <button onClick={submit} disabled={!valid || busy}>Save split</button>
        <button onClick={onDone} disabled={busy}>Cancel</button>
        {t.splits.length > 0 && <button className="link" onClick={() => save([])} disabled={busy}>Remove split</button>}
      </div>
    </div>
  )
}
