import { useMemo, useState } from 'react'
import { api, money } from './api.ts'

// Minimal RFC 4180 parser: quoted fields, escaped quotes, CRLF.
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      if (row.some((f) => f.trim())) rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  row.push(field)
  if (row.some((f) => f.trim())) rows.push(row)
  return rows
}

function parseDate(s: string): string | null {
  const v = s.trim()
  let m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = v.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2}|\d{4})\b/)
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3]
    return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  }
  return null
}

function parseAmount(s: string): number | null {
  let v = s.trim().replace(/[$,\s]/g, '')
  if (!v) return null
  let negative = false
  if (/^\(.*\)$/.test(v)) { negative = true; v = v.slice(1, -1) }
  if (v.endsWith('-')) { negative = true; v = v.slice(0, -1) }
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return negative ? -n : n
}

type Mapping = { date: number; description: number; amount: number; debit: number; credit: number }

function guessMapping(header: string[]): Mapping {
  const find = (re: RegExp, skip = -1) => header.findIndex((h, i) => i !== skip && re.test(h.toLowerCase()))
  const date = find(/date|posted/)
  return {
    date,
    description: find(/desc|payee|merchant|memo|name|details/, date),
    amount: find(/^amount|amount$|^amt/),
    debit: find(/debit|withdrawal|payment/),
    credit: find(/credit|deposit/),
  }
}

// Imports a bank's CSV export into one account, typically a manual account
// SimpleFIN can't reach. Re-importing the same file skips rows already there.
export function CsvImport({ accounts, onError, onDone }: { accounts: any[]; onError: (m: string) => void; onDone: () => void }) {
  const [accountId, setAccountId] = useState('')
  const [rows, setRows] = useState<string[][]>([])
  const [mapping, setMapping] = useState<Mapping | null>(null)
  const [positiveOut, setPositiveOut] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')

  const header = rows[0] ?? []
  const pickFile = async (file: File | undefined) => {
    setResult('')
    if (!file) return
    const parsed = parseCsv(await file.text())
    setRows(parsed)
    setMapping(guessMapping(parsed[0] ?? []))
  }

  // Converted to the app's convention: amount > 0 = money out.
  const converted = useMemo(() => {
    if (!mapping) return []
    return rows.slice(1).map((r) => {
      const date = mapping.date >= 0 ? parseDate(r[mapping.date] ?? '') : null
      const description = mapping.description >= 0 ? (r[mapping.description] ?? '').trim() : ''
      let amount: number | null = null
      if (mapping.amount >= 0) {
        const a = parseAmount(r[mapping.amount] ?? '')
        amount = a == null ? null : positiveOut ? a : -a
      } else if (mapping.debit >= 0 || mapping.credit >= 0) {
        const debit = mapping.debit >= 0 ? Math.abs(parseAmount(r[mapping.debit] ?? '') ?? 0) : 0
        const credit = mapping.credit >= 0 ? Math.abs(parseAmount(r[mapping.credit] ?? '') ?? 0) : 0
        amount = debit || credit ? debit - credit : null
      }
      return { date, description, amount }
    })
  }, [rows, mapping, positiveOut])
  const valid = converted.filter((r) => r.date && r.description && r.amount)

  const submit = async () => {
    setBusy(true)
    try {
      const r = await api(`accounts/${encodeURIComponent(accountId)}/import`, 'POST', { rows: valid })
      setResult(`Imported ${r.added} new rows${r.duplicates ? `, ${r.duplicates} already there` : ''}. Categorizing runs in the background.`)
      setRows([])
      setMapping(null)
      onDone()
    } catch (e: any) {
      onError(e.message)
    }
    setBusy(false)
  }

  const columnSelect = (key: keyof Mapping, label: string) => (
    <label className="map">{label}
      <select value={mapping?.[key] ?? -1} onChange={(e) => mapping && setMapping({ ...mapping, [key]: Number(e.target.value) })}>
        <option value={-1}>—</option>
        {header.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
      </select>
    </label>
  )

  return (
    <section>
      <h2>Import CSV</h2>
      <p className="muted">For accounts SimpleFIN can't reach. Download the transaction history as CSV from the bank's site, then pick the account here.</p>
      <div className="toolbar">
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">Account…</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.org_name ? `${a.org_name} · ` : ''}{a.name}</option>)}
        </select>
        <input type="file" accept=".csv,text/csv" onChange={(e) => pickFile(e.target.files?.[0])} />
      </div>
      {mapping && (
        <>
          <div className="toolbar">
            {columnSelect('date', 'Date')}
            {columnSelect('description', 'Description')}
            {columnSelect('amount', 'Amount')}
            {mapping.amount < 0 && columnSelect('debit', 'Debit')}
            {mapping.amount < 0 && columnSelect('credit', 'Credit')}
          </div>
          {mapping.amount >= 0 && (
            <div className="toolbar">
              <label><input type="checkbox" checked={positiveOut} onChange={(e) => setPositiveOut(e.target.checked)} /> Positive numbers are money out (check the preview)</label>
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead><tr><th className="date">Date</th><th>Description</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {converted.slice(0, 5).map((r, i) => (
                  <tr key={i}>
                    <td className="date">{r.date ?? <span className="over">?</span>}</td>
                    <td>{r.description || <span className="over">?</span>}</td>
                    <td className={`num ${r.amount != null && r.amount < 0 ? 'inflow' : ''}`}>{r.amount == null ? <span className="over">?</span> : money(-r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="toolbar">
            <button onClick={submit} disabled={!accountId || !valid.length || busy}>
              {busy ? 'Importing…' : `Import ${valid.length} rows`}
            </button>
            {converted.length > valid.length && <span className="muted">{converted.length - valid.length} rows skipped (missing date, description or amount)</span>}
            {!accountId && <span className="muted">Pick the account first.</span>}
          </div>
        </>
      )}
      {result && <p className="muted">{result}</p>}
    </section>
  )
}
