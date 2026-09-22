// R90 — utilitaires communs du harnais (Sandbox/dev UNIQUEMENT ; base jetable `settlements_r90` obligatoire). Aucun secret n'est affiché.
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import pg from '/home/benoit_prrn/delivery-service/node_modules/pg/lib/index.js'

export const REPO = '/home/benoit_prrn/delivery-service'
export const RUN_ID = process.env.R90_RUN_ID ?? 'r90-20260922-3'
export const PROTECTED_ACCOUNT_PREFIX = 'acct_1UHTim'
export const CREDENTIALS_FILE = '/tmp/claude-1000/admin-dev-credentials.txt'
const require = createRequire(`${REPO}/package.json`)
export const Stripe = require('stripe')

const envFile = fs.readFileSync(`${REPO}/.env`, 'utf8')
export const env = (name: string): string | undefined => {
  const m = envFile.match(new RegExp(`^${name}=(.*)$`, 'm'))
  const v = m?.[1]?.replace(/\s+#.*$/, '').trim().replace(/^"|"$/g, '')
  return v === '' ? undefined : v
}

/** Refuse toute exécution hors base jetable R90 ou avec une clé Stripe non-Sandbox. */
export function requireR90Database(): string {
  const url = process.env.DATABASE_URL ?? ''
  if (!/\/settlements_r90(\?|$)/.test(url)) throw new Error('base jetable settlements_r90 requise (source docs/work/r90-testdb.sh, sans pipe)')
  return url
}
export function sandboxStripe() {
  const key = env('STRIPE_SECRET_KEY')
  if (!key?.startsWith('sk_test_')) throw new Error('clé Stripe Sandbox (sk_test_) requise ; aucun Stripe Live')
  return new Stripe(key, { maxNetworkRetries: 2 })
}
export const guardStripeId = (id: string): string => {
  if (id.startsWith(PROTECTED_ACCOUNT_PREFIX)) throw new Error('compte Stripe protégé refusé')
  return id
}
export const r90Metadata = (extra: Record<string, string> = {}) => ({ run_id: RUN_ID, campaign: 'r90', ...extra })
export const newPool = () => new pg.Pool({ connectionString: requireR90Database() })
export const randomPassword = () => randomBytes(15).toString('base64url')

export const log = (label: string, value: unknown = '') => console.log(`[${new Date().toISOString().slice(11, 19)}] ${label}`, typeof value === 'string' ? value : JSON.stringify(value))

/** Preuves : une ligne JSON par constat, rattachée à un ou plusieurs points de checklist. */
export function evidence(scenario: string, result: 'OK' | 'KO' | 'INFO', checklist: string[], detail: unknown): void {
  fs.mkdirSync(`${REPO}/docs/work/r90/evidence`, { recursive: true })
  fs.appendFileSync(`${REPO}/docs/work/r90/evidence/${RUN_ID}.jsonl`, JSON.stringify({ at: new Date().toISOString(), run_id: RUN_ID, scenario, result, checklist, detail }) + '\n')
  log(`${result} ${scenario}`, { checklist, detail })
}

// --- Supabase Auth (dev) : administration + connexion par mot de passe ---
const supabaseUrl = () => env('SUPABASE_URL') ?? ''
const secretKey = () => env('SUPABASE_SECRET_KEY') ?? ''
const adminHeaders = () => ({ apikey: secretKey(), Authorization: `Bearer ${secretKey()}`, 'content-type': 'application/json' })
export async function authAdminListUsers(): Promise<Array<{ id: string; email: string; app_metadata: Record<string, unknown> }>> {
  const r = await fetch(`${supabaseUrl()}/auth/v1/admin/users?per_page=200`, { headers: adminHeaders() })
  if (!r.ok) throw new Error(`auth admin list ${r.status}`)
  return ((await r.json()) as { users: Array<{ id: string; email: string; app_metadata: Record<string, unknown> }> }).users
}
export async function authAdminCreateUser(email: string, password: string, role: 'merchant' | 'driver' | 'admin', extraAppMeta: Record<string, unknown> = {}): Promise<string> {
  const r = await fetch(`${supabaseUrl()}/auth/v1/admin/users`, { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ email, password, email_confirm: true, app_metadata: { role, run_id: RUN_ID, ...extraAppMeta } }) })
  if (!r.ok) throw new Error(`auth admin create ${r.status}`)
  return ((await r.json()) as { id: string }).id
}
export async function authAdminSetPassword(userId: string, password: string): Promise<void> {
  const r = await fetch(`${supabaseUrl()}/auth/v1/admin/users/${userId}`, { method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ password }) })
  if (!r.ok) throw new Error(`auth admin password ${r.status}`)
}
export async function authAdminDeleteUser(userId: string): Promise<void> {
  const r = await fetch(`${supabaseUrl()}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: adminHeaders() })
  if (!r.ok) throw new Error(`auth admin delete ${r.status}`)
}
export async function signIn(email: string, password: string): Promise<string> {
  const r = await fetch(`${supabaseUrl()}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: env('SUPABASE_ANON_KEY') ?? '', 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
  if (!r.ok) throw new Error(`signIn ${r.status}`)
  return ((await r.json()) as { access_token: string }).access_token
}

// --- Appels vers l'instance API R90 ---
export const R90_API = process.env.R90_API_URL ?? 'http://127.0.0.1:3100'
export async function api(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${R90_API}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text.slice(0, 200) }
  return { status: r.status, json }
}

/** Envoie un événement Stripe SIGNÉ localement (secret webhook lu de .env, jamais affiché) vers la vraie route de l'API R90. */
export async function postSignedWebhook(event: { id: string; type: string; data: { object: Record<string, unknown> }; account?: string }, opts: { tamper?: boolean } = {}): Promise<number> {
  const secret = env('STRIPE_WEBHOOK_SECRET') ?? ''
  const payload = JSON.stringify({ object: 'event', api_version: '2025-01-27.acacia', created: Math.floor(Date.now() / 1000), livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null }, ...event })
  const header = sandboxStripe().webhooks.generateTestHeaderString({ payload: opts.tamper ? payload : payload, secret })
  const body = opts.tamper ? payload.replace('"livemode":false', '"livemode":true ') : payload
  const r = await fetch(`${R90_API}/api/v1/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body })
  return r.status
}
