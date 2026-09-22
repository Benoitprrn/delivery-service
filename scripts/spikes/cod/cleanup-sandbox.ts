/** Nettoyage des comptes Sandbox JETABLES créés aujourd'hui par les spikes (NE PAS LIVRER). --apply pour fermer. */
import { readFileSync } from 'node:fs'
import Stripe from 'stripe'
process.loadEnvFile('.env')
const key = process.env.STRIPE_SECRET_KEY ?? ''
if (!/^(sk|rk)_test_/.test(key)) { console.error('Abandon : clé non Sandbox.'); process.exit(1) }
const state = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as { A: string; B: string }
const keep = new Set([state.A, state.B, ...process.argv.slice(3)])
const apply = process.argv.includes('--apply')
const since = '2026-09-20T09:00:00.000Z'
const stripe = new Stripe(key, { timeout: 30_000, maxNetworkRetries: 1 })
const accounts = (stripe.v2.core as any).accounts
const err = (e: any) => `${e?.code ?? e?.type}: ${String(e?.message).slice(0, 100)}`
async function main() {
  const list: any[] = []
  for await (const account of accounts.list({ limit: 20 })) list.push(account)
  const candidates = list.filter((a) => !a.closed && a.created >= since && !keep.has(a.id) && a.livemode === false)
  console.log(`total=${list.length} ouverts créés depuis ${since} et hors liste à garder: ${candidates.length} (${apply ? 'FERMETURE' : 'essai à blanc'})`)
  let closed = 0, failed = 0
  for (const a of candidates) {
    if (!apply) continue
    try { await accounts.close(a.id, { applied_configurations: a.applied_configurations }); closed++ } catch (e) { failed++; console.log('échec', a.id, err(e)) }
  }
  if (apply) console.log(`fermés=${closed} échecs=${failed}`)
}
main().catch((e) => { console.error(err(e)); process.exit(1) })
