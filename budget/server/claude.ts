import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'

// AI features run through the Claude Code CLI on the user's subscription,
// the same way the Workout Tracker and Trading Terminal add-ons do. The
// sign-in lives in CLAUDE_CONFIG_DIR (/data/claude in the add-on) so it
// survives updates; a `claude setup-token` token from the options is the fallback.

const CONFIG_DIR = path.join(config.dataDir, 'claude')
const WORK_DIR = path.join(config.dataDir, 'claude-work')
fs.mkdirSync(CONFIG_DIR, { recursive: true })
fs.mkdirSync(WORK_DIR, { recursive: true })

// Resolved through PATH (claude.exe on Windows from the native installer, claude on Linux).
const BIN = 'claude'

type AuthStatus = { loggedIn?: boolean; authMethod?: string; expired?: boolean; error?: string }
let statusCache: { at: number; value: AuthStatus } = { at: 0, value: {} }

function env(useToken: boolean): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: CONFIG_DIR, DISABLE_AUTOUPDATER: '1', BROWSER: 'none', NO_COLOR: '1' }
  delete e.ANTHROPIC_API_KEY // an API key would override the subscription login
  delete e.CLAUDE_CODE_OAUTH_TOKEN
  if (useToken && config.claudeOauthToken) e.CLAUDE_CODE_OAUTH_TOKEN = config.claudeOauthToken.replace(/\s+/g, '')
  return e
}

function run(args: string[], input: string, useToken: boolean, timeoutMs: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(BIN, args, { env: env(useToken), cwd: WORK_DIR, windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`Claude Code CLI not available: ${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
    child.stdin.end(input)
  })
}

export async function authStatus(maxAgeMs = 10 * 60 * 1000): Promise<AuthStatus> {
  if (Date.now() - statusCache.at < maxAgeMs) return statusCache.value
  let value: AuthStatus = {}
  try {
    const { out } = await run(['auth', 'status'], '', false, 20000)
    const i = out.indexOf('{')
    value = i >= 0 ? JSON.parse(out.slice(i)) : {}
  } catch (err: any) {
    console.error('claude auth status failed:', err.message)
    value = {}
  }
  statusCache = { at: Date.now(), value }
  return value
}

export async function signedIn(): Promise<boolean> {
  const s = await authStatus()
  return Boolean(s.loggedIn) && ['claude.ai', 'oauth_token', 'claude_ai'].includes(s.authMethod ?? '')
}

export async function available(): Promise<boolean> {
  return (await signedIn()) || Boolean(config.claudeOauthToken)
}

const isAuthError = (msg: string) => /authenticate|oauth|log in|login|not logged|unauthorized|401/i.test(msg)

const BASE_ARGS = ['-p', '--restricted', '--no-session-persistence', '--tools', '', '--max-turns', '1', '--effort', 'low']

// One complete answer, no tools, no session saved.
export async function askClaude(prompt: string, timeoutMs = 180000): Promise<string> {
  const useToken = !(await signedIn())
  const { out, err } = await run([...BASE_ARGS, '--model', config.claudeModel, '--output-format', 'json'], prompt, useToken, timeoutMs)
  const i = out.indexOf('{')
  let data: any
  try {
    data = JSON.parse(out.slice(i))
  } catch {
    throw new Error(`Claude Code failed: ${(err || out).trim().slice(0, 300)}`)
  }
  return resultText(data)
}

// Same, with one image (a receipt photo). The image goes in as a content
// block over stream-json input, so the CLI still gets no file access.
export async function askClaudeWithImage(prompt: string, image: { data: string; mediaType: string }, timeoutMs = 180000): Promise<string> {
  const useToken = !(await signedIn())
  const message = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
        { type: 'text', text: prompt },
      ],
    },
  }
  const args = [...BASE_ARGS, '--model', config.claudeModel, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
  const { out, err } = await run(args, `${JSON.stringify(message)}\n`, useToken, timeoutMs)
  const result = out
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .find((event) => event?.type === 'result')
  if (!result) throw new Error(`Claude Code failed: ${(err || out).trim().slice(0, 300)}`)
  return resultText(result)
}

function resultText(data: any): string {
  if (data.is_error) {
    const msg = String(data.result || data.subtype || 'unknown error')
    if (isAuthError(msg)) {
      statusCache = { at: Date.now() + 365 * 24 * 3600 * 1000, value: { loggedIn: false, expired: true, error: msg } }
      throw new Error('Claude sign-in expired or missing. Connect Claude in the Accounts tab.')
    }
    throw new Error(`Claude Code: ${msg}`)
  }
  return String(data.result ?? '')
}

// `claude auth login --claudeai`, driven from the web page: it prints a link,
// the user approves in a browser and pastes the code back.
let login: { proc: ReturnType<typeof spawn>; output: string; started: number } | null = null

export function startLogin(): void {
  if (login && login.proc.exitCode === null) return
  const proc = spawn(BIN, ['auth', 'login', '--claudeai'], { env: env(false), cwd: WORK_DIR, windowsHide: true })
  login = { proc, output: '', started: Date.now() }
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  proc.stdout?.on('data', (d) => (login!.output += strip(String(d))))
  proc.stderr?.on('data', (d) => (login!.output += strip(String(d))))
  proc.on('close', () => (statusCache = { at: 0, value: {} }))
}

export function loginState(): { running: boolean; url: string | null; message: string } {
  if (!login) return { running: false, url: null, message: '' }
  const url = login.output.match(/https:\/\/\S+/)?.[0] ?? null
  const lines = login.output.split('\n').map((l) => l.trim()).filter((l) => l && !l.includes('http'))
  return { running: login.proc.exitCode === null, url, message: lines.at(-1) ?? '' }
}

export function sendLoginCode(code: string): void {
  if (!login || login.proc.exitCode !== null) throw new Error('No sign-in in progress')
  login.proc.stdin?.write(code.replace(/\s+/g, '') + '\n')
}

export async function logout(): Promise<void> {
  await run(['auth', 'logout'], '', false, 20000).catch(() => undefined)
  statusCache = { at: 0, value: {} }
}
