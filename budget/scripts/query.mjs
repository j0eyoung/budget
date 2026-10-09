// Run a read-only SQL query against the budget app and print the rows as JSON.
// Usage: node scripts/query.mjs "SELECT ..."
// BUDGET_URL and BUDGET_TOKEN point it at a remote instance (e.g. Home Assistant).
const sql = process.argv.slice(2).join(' ')
if (!sql) {
  console.error('Usage: node scripts/query.mjs "SELECT ..."')
  process.exit(1)
}

try {
  process.loadEnvFile(new URL('../.env', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
} catch {
  // no .env file
}
const base = (process.env.BUDGET_URL || `http://127.0.0.1:${process.env.PORT || 8099}`).replace(/\/$/, '')
const token = process.env.BUDGET_TOKEN || process.env.API_TOKEN

const res = await fetch(`${base}/api/query`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ sql }),
})
const data = await res.json()
if (!res.ok) {
  console.error(data.error || res.statusText)
  process.exit(1)
}
console.log(JSON.stringify(data.rows, null, 2))
