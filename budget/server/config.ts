import fs from 'node:fs'
import path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
try {
  process.loadEnvFile(path.join(APP_DIR, '.env'))
} catch {
  // no .env file; rely on real environment variables or add-on options
}

// When running as a Home Assistant add-on, options arrive in this file.
const HA_OPTIONS = '/data/options.json'
const isAddon = fs.existsSync(HA_OPTIONS)
const opts: Record<string, string> = isAddon ? JSON.parse(fs.readFileSync(HA_OPTIONS, 'utf8')) : {}

const pick = (opt: string, env: string, fallback = '') => opts[opt] || process.env[env] || fallback

export const config = {
  isAddon,
  port: Number(process.env.PORT || 8099),
  dataDir: isAddon ? '/data' : path.resolve(APP_DIR, process.env.DATA_DIR || './data'),
  // Nightly database copies. In the add-on, /config is the add-on's own config
  // folder (addon_config map), which survives a wipe of /data.
  backupDir: isAddon ? '/config/backups' : path.resolve(APP_DIR, process.env.DATA_DIR || './data', 'backups'),
  // One-time setup token from bridge.simplefin.org; claimed on first start.
  simplefinSetupToken: pick('simplefin_setup_token', 'SIMPLEFIN_SETUP_TOKEN'),
  // Already-claimed access URL, if you prefer to supply it directly.
  simplefinAccessUrl: pick('simplefin_access_url', 'SIMPLEFIN_ACCESS_URL'),
  // Fallback sign-in for the Claude Code CLI (from `claude setup-token`); the
  // in-app "Connect Claude" login is preferred and wins when present.
  claudeOauthToken: pick('claude_code_oauth_token', 'CLAUDE_CODE_OAUTH_TOKEN'),
  claudeModel: pick('claude_model', 'CLAUDE_MODEL', 'sonnet'),
  apiToken: pick('api_token', 'API_TOKEN'),
}

fs.mkdirSync(config.dataDir, { recursive: true })
