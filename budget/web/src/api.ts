// Paths are relative (no leading slash) so requests stay inside the
// Home Assistant ingress prefix the page is served from.
export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`api/${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

export const money = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

// Whole dollars, for headline numbers and chart labels.
export const dollars = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

export const thisMonth = () => new Date().toISOString().slice(0, 7)

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7)
}

export const monthLabel = (month: string, withYear = true) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: withYear ? 'numeric' : undefined, timeZone: 'UTC' })

// Per-viewer UI preferences; storage can be unavailable (private window), so never rely on it.
export const pref = {
  get: (key: string, fallback: string) => {
    try {
      return localStorage.getItem(`budget.${key}`) ?? fallback
    } catch {
      return fallback
    }
  },
  set: (key: string, value: string) => {
    try {
      localStorage.setItem(`budget.${key}`, value)
    } catch {
      // ignore
    }
  },
}

export type Category = { id: number; name: string; kind: 'expense' | 'income' | 'savings' | 'transfer'; track?: number }
export type BudgetRow = Category & { budget: number; spent: number; prev: number; avg3: number; track: number }
export type Status = {
  connected: boolean
  lastSync: string | null
  aiConfigured: boolean
  health?: { issues: string[]; lastBackup: string | null }
}
export type Split = { id: number; transaction_id: string; amount: number; category_id: number }
export type Transaction = {
  id: string
  date: string
  name: string
  merchant: string | null
  amount: number
  pending: number
  category_id: number | null
  category_source: string
  notes: string | null
  account_name: string | null
  splits: Split[]
}
