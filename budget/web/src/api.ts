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

export const thisMonth = () => new Date().toISOString().slice(0, 7)

export type Category = { id: number; name: string; kind: 'expense' | 'income' | 'savings' | 'transfer' }
export type BudgetRow = Category & { budget: number; spent: number }
export type Status = { connected: boolean; lastSync: string | null; aiConfigured: boolean }
