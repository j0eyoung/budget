import { useEffect, useMemo, useState } from 'react'
import { api, money } from './api.ts'
import { csvRows, guessMapping, hasHeader, isOfx, matchAccount, orient, parseCsv, parseOfx } from './importParse.ts'
import type { Mapping, RawRow } from './importParse.ts'

type Loaded =
  | { kind: 'csv'; names: string[]; table: string[][] } // several files' rows, header once
  | { kind: 'ofx'; names: string[]; rows: RawRow[] }
type Preview = { added: number; duplicates: number; covered: number; invalid: number; syncedFrom: string | null; from: string | null; to: string | null }
type Account = { id: string; name: string; org_name: string | null }

// Imports a bank's export (CSV, or QFX/OFX) into one account: older history
// than bank sync reaches, or an account sync can't reach. The server skips
// anything bank sync or an earlier import already has; a dry run shows the
// counts before anything is saved.
export function CsvImport({ accounts, onError, onDone }: { accounts: Account[]; onError: (m: string) => void; onDone: () => void }) {
  const [accountId, setAccountId] = useState('')
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [mapping, setMapping] = useState<Mapping | null>(null)
  const [positiveOut, setPositiveOut] = useState<boolean | null>(null) // null = use the detected sign
  const [existing, setExisting] = useState<{ date: string; amount: number }[]>([])
  const [matchNote, setMatchNote] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')

  // What's already in the account, to check which sign the file uses.
  useEffect(() => {
    if (!accountId) return setExisting([])
    api<{ date: string; amount: number; pending: number }[]>(`transactions?account=${encodeURIComponent(accountId)}`)
      .then((ts) => setExisting(ts.filter((t) => !t.pending).map((t) => ({ date: t.date, amount: t.amount }))))
      .catch((e) => onError(e.message))
  }, [accountId, onError])

  const pickFiles = async (files: File[]) => {
    setResult('')
    setPositiveOut(null)
    setMatchNote('')
    if (!files.length) return
    const texts = await Promise.all(files.map((f) => f.text()))
    const names = files.map((f) => f.name)
    let hints = names
    if (texts.every(isOfx)) {
      const parsed = texts.map(parseOfx)
      setLoaded({ kind: 'ofx', names, rows: parsed.flatMap((p) => p.rows) })
      setMapping(null)
      hints = [...names, ...parsed.map((p) => p.account)]
    } else if (texts.some(isOfx)) {
      setLoaded(null)
      return onError('Pick either CSV files or QFX/OFX files, not a mix.')
    } else {
      const tables = texts.map(parseCsv)
      const shape = (t: string[][]) => (hasHeader(t) ? t[0].map((h) => h.trim()).join('|') : `${t[0]?.length ?? 0} columns`)
      if (new Set(tables.map(shape)).size > 1) {
        setLoaded(null)
        return onError("Those CSV files have different columns. Import one bank's files at a time.")
      }
      const table = [...tables[0], ...tables.slice(1).flatMap((t) => (hasHeader(t) ? t.slice(1) : t))]
      setLoaded({ kind: 'csv', names, table })
      setMapping(guessMapping(table))
    }
    const matched = matchAccount(accounts, hints)
    if (matched) {
      const a = accounts.find((x) => x.id === matched)!
      setAccountId(matched)
      setMatchNote(`Matched to ${a.org_name ? `${a.org_name} · ` : ''}${a.name} by its last 4 digits. Change it above if that's wrong.`)
    }
  }

  const raw = useMemo<RawRow[]>(
    () => (!loaded ? [] : loaded.kind === 'ofx' ? loaded.rows : mapping ? csvRows(loaded.table, mapping) : []),
    [loaded, mapping],
  )
  // Separate debit/credit columns are unambiguous; a single amount column (or
  // a QFX file) is checked against what the account already has.
  const signed = loaded?.kind === 'ofx' || (mapping != null && mapping.amount >= 0)
  const detected = useMemo(() => (signed ? orient(raw, existing) : null), [signed, raw, existing])
  const positive = !signed || (positiveOut ?? detected?.positiveOut ?? true)
  // The app's convention: amount > 0 = money out.
  const rows = useMemo(() => raw.map((r) => ({ ...r, amount: r.value == null ? null : positive ? r.value : -r.value })), [raw, positive])
  const valid = useMemo(
    () => rows.filter((r) => r.date && r.description && r.amount).map((r) => ({ date: r.date!, description: r.description, amount: r.amount! })),
    [rows],
  )

  useEffect(() => {
    setPreview(null)
    if (!accountId || !valid.length) return
    const t = setTimeout(() => {
      api<Preview>(`accounts/${encodeURIComponent(accountId)}/import`, 'POST', { rows: valid, dryRun: true }).then(setPreview).catch((e) => onError(e.message))
    }, 300)
    return () => clearTimeout(t)
  }, [accountId, valid, onError])

  const submit = async () => {
    setBusy(true)
    try {
      const r = await api<Preview>(`accounts/${encodeURIComponent(accountId)}/import`, 'POST', { rows: valid })
      setResult(
        `Imported ${r.added} transactions${r.from ? ` from ${r.from} to ${r.to}` : ''}.` +
          (r.covered ? ` Skipped ${r.covered} that bank sync already has.` : '') +
          (r.duplicates ? ` ${r.duplicates} were already here.` : '') +
          (r.added ? ' Claude is categorizing the new ones in the background; it takes a few minutes for a big file.' : ''),
      )
      setLoaded(null)
      setMapping(null)
      setPreview(null)
      onDone()
    } catch (e: any) {
      onError(e.message)
    }
    setBusy(false)
  }

  const table = loaded?.kind === 'csv' ? loaded.table : []
  const header = hasHeader(table) ? table[0] ?? [] : (table[0] ?? []).map((_, i) => `Column ${i + 1}`)
  const columnSelect = (key: keyof Mapping, label: string) => (
    <label className="map">{label}
      <select value={mapping?.[key] ?? -1} onChange={(e) => mapping && setMapping({ ...mapping, [key]: Number(e.target.value) })}>
        <option value={-1}>—</option>
        {header.map((h, i) => <option key={i} value={i}>{h.trim() || `Column ${i + 1}`}</option>)}
      </select>
    </label>
  )
  const dates = valid.map((r) => r.date).sort()

  return (
    <section>
      <h2>Import from your bank</h2>
      <p className="muted">
        Fill in history older than bank sync reaches (about 90 days), or an account sync can't reach. On the bank's website, download your transactions as{' '}
        <strong>QFX</strong> or <strong>OFX</strong> (often labeled "Quicken" or "Money") if it's offered, otherwise <strong>CSV</strong>. You can pick several
        files at once. Anything bank sync already has, or that you imported before, is skipped.
      </p>
      <div className="toolbar">
        <input type="file" multiple accept=".csv,.qfx,.ofx,.qbo,text/csv" onChange={(e) => { pickFiles([...(e.target.files ?? [])]); e.target.value = '' }} />
        <select value={accountId} onChange={(e) => { setAccountId(e.target.value); setMatchNote('') }}>
          <option value="">Account…</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.org_name ? `${a.org_name} · ` : ''}{a.name}</option>)}
        </select>
      </div>
      {matchNote && <p className="muted">{matchNote}</p>}
      {loaded && (
        <>
          <p className="muted">
            {loaded.names.length === 1 ? loaded.names[0] : `${loaded.names.length} files`} · {loaded.kind === 'ofx' ? 'QFX/OFX' : 'CSV'} · {valid.length} transactions
            {dates.length ? `, ${dates[0]} to ${dates.at(-1)}` : ''}
          </p>
          {loaded.kind === 'csv' && mapping && (
            <div className="toolbar">
              {columnSelect('date', 'Date')}
              {columnSelect('description', 'Description')}
              {columnSelect('amount', 'Amount')}
              {mapping.amount < 0 && columnSelect('debit', 'Money out')}
              {mapping.amount < 0 && columnSelect('credit', 'Money in')}
            </div>
          )}
          {signed && (
            <div className="toolbar">
              <label>Money out shows in this file as
                <select value={positive ? 'positive' : 'negative'} onChange={(e) => setPositiveOut(e.target.value === 'positive')}>
                  <option value="positive">positive numbers</option>
                  <option value="negative">negative numbers</option>
                </select>
              </label>
              {positiveOut == null && detected && (
                <span className="muted">
                  {detected.basis === 'matched' ? `checked against ${detected.matches} transactions already in the app` : 'guessed (most rows are purchases); check the preview'}
                </span>
              )}
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead><tr><th className="date">Date</th><th>Description</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {rows.slice(0, 5).map((r, i) => (
                  <tr key={i}>
                    <td className="date">{r.date ?? <span className="over">?</span>}</td>
                    <td>{r.description || <span className="over">?</span>}</td>
                    <td className={`num ${r.amount != null && r.amount < 0 ? 'inflow' : ''}`}>{r.amount == null ? <span className="over">?</span> : money(-r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">Purchases should show as negative and payments or deposits in green, the same as the Transactions tab.</p>
          <div className="toolbar">
            <button onClick={submit} disabled={!accountId || busy || !preview?.added}>
              {busy ? 'Importing…' : `Import ${preview ? preview.added : valid.length} transactions`}
            </button>
            {!accountId && <span className="muted">Pick the account first.</span>}
            {preview && (
              <span className="muted">
                {preview.added} new
                {preview.covered ? ` · ${preview.covered} skipped, bank sync has them (from ${preview.syncedFrom})` : ''}
                {preview.duplicates ? ` · ${preview.duplicates} already imported` : ''}
                {rows.length > valid.length ? ` · ${rows.length - valid.length} unreadable rows` : ''}
              </span>
            )}
          </div>
        </>
      )}
      {result && <p className="notice good">{result}</p>}
    </section>
  )
}
