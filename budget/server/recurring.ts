import { db } from './db.ts'
import { today } from './queries.ts'

// Finds subscriptions and bills: the same merchant charging a similar amount
// on a regular schedule. Works from the ledger, so split parts count.

type Charge = { date: string; amount: number; category: string; label: string }

export type Recurring = {
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

const CADENCES = [
  { name: 'weekly', days: 7, min: 5, max: 9 },
  { name: 'every 2 weeks', days: 14, min: 12, max: 14.4 },
  { name: 'twice a month', days: 15.22, min: 14.5, max: 17 },
  { name: 'monthly', days: 30.44, min: 25, max: 36 },
  { name: 'quarterly', days: 91.3, min: 80, max: 100 },
  { name: 'yearly', days: 365.25, min: 340, max: 390 },
]

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

  const now = dayNumber(today())
  const found: Recurring[] = []
  for (const list of byMerchant.values()) {
    // One merchant can carry several subscriptions at different prices, so
    // cluster by amount before looking for a schedule.
    const clusters: Charge[][] = []
    for (const c of [...list].sort((a, b) => a.amount - b.amount)) {
      const cluster = clusters.at(-1)
      if (cluster && c.amount <= cluster[0].amount * 1.35 + 1) cluster.push(c)
      else clusters.push([c])
    }

    for (const cluster of clusters) {
      const byDate = new Map<string, Charge>()
      for (const c of cluster) {
        const same = byDate.get(c.date)
        if (same) same.amount += c.amount
        else byDate.set(c.date, { ...c })
      }
      const series = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
      if (series.length < 2) continue

      const intervals = series.slice(1).map((c, i) => dayNumber(c.date) - dayNumber(series[i].date))
      const typical = median(intervals)
      const cadence = CADENCES.find((c) => typical >= c.min && typical <= c.max)
      if (!cadence) continue
      const tolerance = Math.max(3, cadence.days * 0.2)
      if (intervals.filter((d) => Math.abs(d - cadence.days) <= tolerance).length / intervals.length < 0.6) continue

      const amounts = series.map((c) => c.amount)
      const prior = amounts.slice(0, -1)
      const base = median(prior)
      const last = series.at(-1)!
      const priorMean = prior.reduce((s, a) => s + a, 0) / prior.length
      const priorSd = Math.sqrt(prior.reduce((s, a) => s + (a - priorMean) ** 2, 0) / prior.length)
      const variable = prior.length >= 2 && priorSd / priorMean > 0.08
      // Two charges are a weak signal; only trust them when the amount roughly repeats.
      if (series.length === 2 && Math.abs(last.amount - base) / base > 0.25) continue
      if (HABIT_CATEGORIES.has(last.category) && amounts.some((a) => Math.abs(a - base) / base > 0.01)) continue

      const average = amounts.reduce((s, a) => s + a, 0) / amounts.length
      const lastDay = dayNumber(last.date)
      found.push({
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
