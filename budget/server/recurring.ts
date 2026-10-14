import { db } from './db.ts'
import { today } from './queries.ts'

// Finds subscriptions and bills: the same merchant charging a similar amount
// on a regular schedule. Works from the ledger, so split parts count.

type Charge = { date: string; amount: number; category: string; label: string }

type Override = { merchant_key: string; status: 'yes' | 'no'; cadence: string | null }

export type Recurring = {
  key: string
  confirmed: boolean
  merchant: string
  category: string
  cadence: string
  amount: number
  average: number
  monthly: number
  count: number
  lastDate: string
  nextDate: string
  variable: boolean
  increase: { from: number; to: number } | null
  stopped: boolean
}

export const CADENCES = [
  { name: 'weekly', days: 7, min: 5, max: 9 },
  { name: 'every 2 weeks', days: 14, min: 12, max: 14.4 },
  { name: 'twice a month', days: 15.22, min: 14.5, max: 17 },
  { name: 'monthly', days: 30.44, min: 25, max: 36 },
  { name: 'quarterly', days: 91.3, min: 80, max: 100 },
  { name: 'yearly', days: 365.25, min: 340, max: 390 },
]
const MONTHLY = CADENCES[3]
const nearestCadence = (days: number) =>
  CADENCES.reduce((best, c) => (Math.abs(Math.log(c.days / days)) < Math.abs(Math.log(best.days / days)) ? c : best))

// Regular trips to the same store aren't bills. In these categories only an
// identical repeating amount (a membership, a meal plan) counts.
const HABIT_CATEGORIES = new Set(['Groceries', 'Dining', 'Shopping', 'Transportation', 'Home', 'Personal Care'])

const DAY = 86400000
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const normalize = (label: string) =>
  label.toLowerCase().replace(/#?\d{3,}/g, ' ').replace(/[^a-z0-9&' ]+/g, ' ').replace(/\s+/g, ' ').trim()

export function detectRecurring(): Recurring[] {
  const charges = db.prepare(`
    SELECT l.date, l.amount, c.name AS category, COALESCE(l.merchant, l.name) AS label
    FROM ledger l JOIN categories c ON c.id = l.category_id
    WHERE c.kind = 'expense' AND l.amount > 0 AND l.pending = 0 AND l.date >= date('now', '-400 days')
    ORDER BY l.date`).all() as Charge[]

  const byMerchant = new Map<string, Charge[]>()
  for (const c of charges) {
    const key = normalize(c.label ?? '')
    if (!key) continue
    if (!byMerchant.has(key)) byMerchant.set(key, [])
    byMerchant.get(key)!.push(c)
  }
  const overrides = new Map(
    (db.prepare('SELECT merchant_key, status, cadence FROM recurring_overrides').all() as Override[]).map((o) => [o.merchant_key, o]),
  )

  const now = dayNumber(today())
  const found: Recurring[] = []
  for (const [key, list] of byMerchant) {
    // The user's call wins: "no" hides the merchant, "yes" skips the
    // regularity checks and can pin how often it charges.
    const override = overrides.get(key)
    if (override?.status === 'no') continue
    const confirmed = override?.status === 'yes'
    const pinned = confirmed && override.cadence ? CADENCES.find((c) => c.name === override.cadence) : undefined

    // One merchant can carry several subscriptions at different prices, so
    // cluster by amount before looking for a schedule. For a merchant the
    // user confirmed, clusters are looser (fuel fill-ups vary) and only the
    // repeating ones count, or the latest charge if nothing repeats yet.
    let clusters: Charge[][] = []
    const spread = confirmed ? 2.5 : 1.35
    for (const c of [...list].sort((a, b) => a.amount - b.amount)) {
      const cluster = clusters.at(-1)
      if (cluster && c.amount <= cluster[0].amount * spread + 1) cluster.push(c)
      else clusters.push([c])
    }
    if (confirmed) {
      const repeating = clusters.filter((c) => c.length >= 2)
      const latest = (c: Charge[]) => c.reduce((d, x) => (x.date > d ? x.date : d), '')
      clusters = repeating.length ? repeating : [clusters.reduce((a, b) => (latest(b) > latest(a) ? b : a))]
    }

    for (const cluster of clusters) {
      const byDate = new Map<string, Charge>()
      for (const c of cluster) {
        const same = byDate.get(c.date)
        if (same) same.amount += c.amount
        else byDate.set(c.date, { ...c })
      }
      const series = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
      if (series.length < (confirmed ? 1 : 2)) continue

      const intervals = series.slice(1).map((c, i) => dayNumber(c.date) - dayNumber(series[i].date))
      const typical = intervals.length ? median(intervals) : null
      let cadence = pinned ?? (typical != null ? CADENCES.find((c) => typical >= c.min && typical <= c.max) : undefined)
      if (!cadence && confirmed) cadence = typical != null ? nearestCadence(typical) : MONTHLY
      if (!cadence) continue

      const amounts = series.map((c) => c.amount)
      const prior = amounts.length > 1 ? amounts.slice(0, -1) : amounts
      const base = median(prior)
      const last = series.at(-1)!
      const priorMean = prior.reduce((s, a) => s + a, 0) / prior.length
      const priorSd = Math.sqrt(prior.reduce((s, a) => s + (a - priorMean) ** 2, 0) / prior.length)
      const variable = prior.length >= 2 && priorSd / priorMean > 0.08
      if (!confirmed) {
        const tolerance = Math.max(3, cadence.days * 0.2)
        if (intervals.filter((d) => Math.abs(d - cadence.days) <= tolerance).length / intervals.length < 0.6) continue
        // Two charges are a weak signal: only trust them for a monthly-or-longer
        // gap and when the amount roughly repeats.
        if (series.length === 2 && (cadence.days < 25 || Math.abs(last.amount - base) / base > 0.25)) continue
        if (HABIT_CATEGORIES.has(last.category) && amounts.some((a) => Math.abs(a - base) / base > 0.01)) continue
      }

      const average = amounts.reduce((s, a) => s + a, 0) / amounts.length
      const lastDay = dayNumber(last.date)
      found.push({
        key,
        confirmed,
        merchant: last.label,
        category: last.category,
        cadence: cadence.name,
        amount: last.amount,
        average,
        monthly: (average * 30.44) / cadence.days,
        count: series.length,
        lastDate: last.date,
        nextDate: new Date(Math.round(lastDay + cadence.days) * DAY).toISOString().slice(0, 10),
        variable,
        increase: !variable && last.amount > base * 1.02 && last.amount - base >= 0.5 ? { from: base, to: last.amount } : null,
        stopped: now - lastDay > cadence.days * 1.6 + 3,
      })
    }
  }
  return found.sort((a, b) => Number(a.stopped) - Number(b.stopped) || b.monthly - a.monthly)
}

// Merchants the user marked "not recurring", so the page can offer an undo.
export function ignoredRecurring(): { key: string; label: string }[] {
  return db.prepare(`SELECT merchant_key AS key, COALESCE(label, merchant_key) AS label FROM recurring_overrides WHERE status = 'no' ORDER BY label`).all() as any[]
}

export function setRecurringOverride(input: { key?: string; label?: string; status?: string; cadence?: string }) {
  const label = String(input.label ?? '').trim()
  const key = String(input.key || normalize(label))
  if (!key) throw new Error('Missing merchant')
  const status = input.status === 'no' ? 'no' : 'yes'
  const cadence = status === 'yes' && CADENCES.some((c) => c.name === input.cadence) ? input.cadence! : null
  db.prepare(`
    INSERT INTO recurring_overrides (merchant_key, label, status, cadence) VALUES (?, ?, ?, ?)
    ON CONFLICT(merchant_key) DO UPDATE SET label = COALESCE(excluded.label, label), status = excluded.status, cadence = excluded.cadence`)
    .run(key, label || null, status, cadence)
}

export function clearRecurringOverride(key: string) {
  db.prepare('DELETE FROM recurring_overrides WHERE merchant_key = ?').run(key)
}
