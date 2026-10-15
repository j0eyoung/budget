// Reading bank exports in the browser: CSV (any bank, columns guessed) and
// QFX/OFX (the "Quicken" download, fixed format). Rows come out as
// {date, description, value} with value signed the way the file signs it.

export type RawRow = { date: string | null; description: string; value: number | null }
export type Mapping = { date: number; description: number; amount: number; debit: number; credit: number }

// Minimal RFC 4180 parser: quoted fields, escaped quotes, CRLF.
export function parseCsv(text: string): string[][] {
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

export function parseDate(s: string): string | null {
  const v = s.trim()
  let m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = v.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2}|\d{4})\b/)
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  m = v.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  return null
}

export function parseAmount(s: string): number | null {
  let v = s.trim().replace(/[$,\s]/g, '')
  if (!v) return null
  let negative = false
  if (/^\(.*\)$/.test(v)) { negative = true; v = v.slice(1, -1) }
  if (v.endsWith('-')) { negative = true; v = v.slice(0, -1) }
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return negative ? -n : n
}

// A first row with a date in it is data, not a header (some banks, e.g. Wells Fargo).
export const hasHeader = (rows: string[][]) => !(rows[0] ?? []).some((f) => parseDate(f) != null)

// Columns from header names, or from the values when there's no header:
// the posted date over the transaction date (bank sync uses posted dates),
// the description over "details"-style type columns.
export function guessMapping(rows: string[][]): Mapping {
  if (hasHeader(rows)) {
    const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase())
    const find = (...res: RegExp[]) => {
      for (const re of res) {
        const i = header.findIndex((h) => re.test(h))
        if (i >= 0) return i
      }
      return -1
    }
    return {
      date: find(/post/, /date/),
      description: find(/desc/, /payee|merchant|name/, /memo|details/),
      amount: find(/^amount|amount$|^amt/),
      debit: find(/debit|withdraw/),
      credit: find(/credit|deposit/),
    }
  }
  const sample = rows.slice(0, 20)
  const width = Math.max(...sample.map((r) => r.length))
  const share = (i: number, test: (v: string) => boolean) => sample.filter((r) => test(r[i] ?? '')).length / sample.length
  const cols = [...Array(width).keys()]
  const date = cols.find((i) => share(i, (v) => parseDate(v) != null) > 0.8) ?? -1
  const amount = cols.find((i) => i !== date && share(i, (v) => /\d/.test(v) && parseAmount(v) != null) > 0.8) ?? -1
  const textLength = (i: number) => sample.reduce((s, r) => s + (/[a-z]/i.test(r[i] ?? '') ? (r[i] ?? '').length : 0), 0)
  const description = cols.filter((i) => i !== date && i !== amount).sort((a, b) => textLength(b) - textLength(a))[0] ?? -1
  return { date, description, amount, debit: -1, credit: -1 }
}

// Debit/credit columns come out already as money-out-positive; a single
// amount column keeps the file's sign for the caller to orient.
export function csvRows(rows: string[][], mapping: Mapping): RawRow[] {
  return rows.slice(hasHeader(rows) ? 1 : 0).map((r) => {
    const date = mapping.date >= 0 ? parseDate(r[mapping.date] ?? '') : null
    const description = mapping.description >= 0 ? (r[mapping.description] ?? '').replace(/\s+/g, ' ').trim() : ''
    let value: number | null = null
    if (mapping.amount >= 0) value = parseAmount(r[mapping.amount] ?? '')
    else if (mapping.debit >= 0 || mapping.credit >= 0) {
      const debit = mapping.debit >= 0 ? Math.abs(parseAmount(r[mapping.debit] ?? '') ?? 0) : 0
      const credit = mapping.credit >= 0 ? Math.abs(parseAmount(r[mapping.credit] ?? '') ?? 0) : 0
      value = debit || credit ? debit - credit : null
    }
    return { date, description, value }
  })
}

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&quot;/g, '"')

export const isOfx = (text: string) => /<OFX>|OFXHEADER/i.test(text.slice(0, 2000))

// QFX/OFX: one <STMTTRN> block per transaction. TRNAMT is negative for money
// out, for bank and card statements alike, so value = -TRNAMT (money out positive).
export function parseOfx(text: string): { account: string; rows: RawRow[] } {
  const tag = (block: string, name: string) => decode(block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, 'i'))?.[1].trim() ?? '')
  const rows = text.split(/<STMTTRN>/i).slice(1).map((block) => {
    const posted = tag(block, 'DTPOSTED') || tag(block, 'DTUSER')
    const amount = parseAmount(tag(block, 'TRNAMT'))
    const name = tag(block, 'NAME')
    const memo = tag(block, 'MEMO')
    const description = name && memo && !name.includes(memo) && !memo.includes(name) ? `${name} ${memo}` : name || memo
    return { date: parseDate(posted.slice(0, 8)), description: description.replace(/\s+/g, ' '), value: amount == null ? null : -amount }
  })
  return { account: tag(text, 'ACCTID'), rows }
}

// The account a file belongs to, from 4-digit groups in its name or the
// OFX account number, matched against "(1234)" in account names.
export function matchAccount(accounts: { id: string; name: string }[], hints: string[]): string | null {
  const digits = new Set(hints.flatMap((h) => [...h.matchAll(/(\d{4})(?!\d)/g)].map((m) => m[1])))
  const hits = accounts.filter((a) => [...digits].some((d) => a.name.includes(`(${d})`) || a.name.endsWith(d)))
  return hits.length === 1 ? hits[0].id : null
}

// Whether positive values in the file mean money out. Best evidence: rows that
// match a transaction already in the app (same amount, within 3 days). Without
// enough of those, most rows in any bank or card export are money out.
export function orient(rows: RawRow[], existing: { date: string; amount: number }[]): { positiveOut: boolean; basis: 'matched' | 'majority'; matches: number } {
  const byAmount = new Map<string, { date: string; amount: number }[]>()
  for (const t of existing) {
    const key = Math.abs(t.amount).toFixed(2)
    if (!byAmount.has(key)) byAmount.set(key, [])
    byAmount.get(key)!.push(t)
  }
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86400000
  let same = 0
  let opposite = 0
  for (const r of rows) {
    if (r.value == null || !r.date || r.value === 0) continue
    const t = byAmount.get(Math.abs(r.value).toFixed(2))?.find((x) => Math.abs(day(x.date) - day(r.date!)) <= 3)
    if (!t) continue
    if (Math.sign(t.amount) === Math.sign(r.value)) same++
    else opposite++
  }
  if (same + opposite >= 3 && Math.max(same, opposite) >= (same + opposite) * 0.75) {
    return { positiveOut: same > opposite, basis: 'matched', matches: same + opposite }
  }
  const negatives = rows.filter((r) => (r.value ?? 0) < 0).length
  const positives = rows.filter((r) => (r.value ?? 0) > 0).length
  return { positiveOut: positives >= negatives, basis: 'majority', matches: 0 }
}
