import { db, meta } from './db.ts'

// SimpleFIN connections break quietly (a bank wants a re-login, a sync job
// fails), so surface anything that looks stale.
export function syncHealth() {
  const lastSync = meta.get('last_sync')
  const failure = JSON.parse(meta.get('last_sync_failure') || 'null') as { at: string; message: string } | null
  const errors = JSON.parse(meta.get('last_sync_errors') || '[]') as string[]
  const stale = db.prepare(`
    SELECT name, org_name, balance_date FROM accounts
    WHERE source = 'simplefin' AND balance_date < date('now', '-3 days') ORDER BY balance_date`).all() as any[]
  const manualDue = db.prepare(`
    SELECT name, org_name, balance_date FROM accounts
    WHERE source = 'manual' AND balance_date < date('now', '-35 days') ORDER BY balance_date`).all() as any[]

  const issues: string[] = []
  if (failure) issues.push(`Last sync failed: ${failure.message}`)
  const hours = lastSync ? (Date.now() - Date.parse(lastSync)) / 3600000 : null
  if (hours != null && hours > 48) issues.push(`No successful sync in ${Math.floor(hours / 24)} days.`)
  for (const e of errors) issues.push(`SimpleFIN: ${e}`)
  for (const a of stale) {
    issues.push(`${a.org_name ? `${a.org_name} ` : ''}${a.name} hasn't updated since ${a.balance_date}. Check the connection at bridge.simplefin.org.`)
  }
  for (const a of manualDue) issues.push(`${a.name} balance was last entered ${a.balance_date}. Update it in Accounts.`)
  return { lastSync, lastBackup: meta.get('last_backup'), issues }
}
