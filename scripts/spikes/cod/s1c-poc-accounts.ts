/**
 * S1c — comptes Sandbox JETABLES pour le POC A→B→A (NE PAS LIVRER).
 *   npx tsx scripts/spikes/cod/s1c-poc-accounts.ts --create --state <fichier.json>
 *   npx tsx scripts/spikes/cod/s1c-poc-accounts.ts --links  --state <fichier.json>
 *   npx tsx scripts/spikes/cod/s1c-poc-accounts.ts --status --state <fichier.json>
 * --create : 2 comptes (A, B) comme la prod (customer-only + prefill) puis ajout merchant full/stripe/stripe.
 * --links  : régénère les liens d'onboarding hébergés (expirent en ~10 min).
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import Stripe from 'stripe'
import { StripeApiProvider } from '../../../apps/api/src/modules/payments/infrastructure/stripe-provider.js'

process.loadEnvFile('.env')
const key = process.env.STRIPE_SECRET_KEY ?? ''
if (!/^(sk|rk)_test_/.test(key)) { console.error('Abandon : clé non Sandbox.'); process.exit(1) }
const arg = (n: string): string | undefined => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined }
const state = arg('--state')
if (state === undefined) { console.error('--state <fichier> requis'); process.exit(1) }
const stripe = new Stripe(key, { timeout: 30_000, maxNetworkRetries: 1 })
const provider = new StripeApiProvider(key, 'whsec_unused_in_spike', stripe)
const accounts = (stripe.v2.core as any).accounts
const INCLUDE = ['configuration.merchant', 'defaults', 'requirements']
// Garde-fous (revue S2) : jamais l'Account SEPA existant, uniquement des comptes créés par ce script.
const FORBIDDEN = new Set(['acct_1UHTimJwc2CYzaPJ'])
type Saved = { createdBy?: string; A?: string; B?: string }
const saved: Saved = existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : {}
if (existsSync(state) && saved.createdBy !== 's1c') { console.error('Abandon : le fichier d\'état n\'a pas été créé par ce script.'); process.exit(1) }
for (const id of [saved.A, saved.B]) if (id !== undefined && (FORBIDDEN.has(id) || !/^acct_/.test(id))) { console.error('Abandon : identifiant de compte interdit ou invalide dans l\'état.'); process.exit(1) }
async function assertSandboxThrowaway(id: string): Promise<void> {
  const a = await accounts.retrieve(id, { include: ['configuration.customer'] })
  if (a.livemode !== false || FORBIDDEN.has(id) || a.metadata?.merchant_id === undefined) throw new Error(`Compte ${id} refusé par les garde-fous`)
}

async function createOne(label: 'A' | 'B'): Promise<string> {
  const { id } = await provider.createCustomerAccount({ merchantId: randomUUID() })
  if (FORBIDDEN.has(id)) throw new Error('compte interdit')
  await provider.updateCustomerAccount(id, {
    email: `poc-${label.toLowerCase()}@example.com`,
    legalName: `POC Restaurant ${label} SARL`,
    address: { line1: `${label === 'A' ? 1 : 2} Rue de la République`, line2: 'Bât. A', city: 'Bourg-en-Bresse', postalCode: '01000', countryCode: 'FR' }
  })
  await accounts.update(id, { contact_phone: '+33474000000', identity: { business_details: { phone: '+33474000000' } } })
  await accounts.update(id, {
    dashboard: 'full',
    defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
    configuration: { merchant: { mcc: '5812', support: { phone: '+33474000000' }, capabilities: { card_payments: { requested: true } } } }
  })
  return id
}

async function main(): Promise<void> {
  if (process.argv.includes('--create')) {
    if (existsSync(state!) && !process.argv.includes('--force-new')) { console.error('Abandon : état existant (comptes A/B déjà créés). --force-new pour en créer de nouveaux.'); process.exit(1) }
    saved.createdBy = 's1c'
    saved.A = await createOne('A'); writeFileSync(state!, JSON.stringify(saved, null, 2), { mode: 0o600 })
    saved.B = await createOne('B'); writeFileSync(state!, JSON.stringify(saved, null, 2), { mode: 0o600 })
    console.log('Comptes créés :', saved)
  }
  for (const label of ['A', 'B'] as const) {
    const id = saved[label]
    if (id === undefined) continue
    await assertSandboxThrowaway(id)
    if (process.argv.includes('--status')) {
      const a = await accounts.retrieve(id, { include: INCLUDE })
      console.log(label, id, 'card_payments=', a.configuration?.merchant?.capabilities?.card_payments?.status, 'requirements=', (a.requirements?.entries ?? []).length)
    }
    if (process.argv.includes('--links')) {
      const link = await (stripe.v2.core as any).accountLinks.create({
        account: id,
        use_case: { type: 'account_onboarding', account_onboarding: { configurations: ['customer', 'merchant'], return_url: 'https://example.com/return', refresh_url: 'https://example.com/refresh' } }
      })
      // Lien bearer à usage unique (~10 min) : affiché sur le terminal de l'opérateur seulement, jamais écrit sur disque.
      console.log(`Lien ${label} (expire ${link.expires_at}) :\n${link.url}`)
    }
  }
}
main().catch((e) => { console.error(e?.cause?.code ?? e?.code, String(e?.cause?.message ?? e?.message).slice(0, 300)); process.exit(1) })
