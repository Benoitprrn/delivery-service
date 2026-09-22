/**
 * S1 — spike jetable COD (Sandbox uniquement). NE PAS LIVRER.
 * Crée des Accounts v2 JETABLES (jamais l'Account SEPA existant) et relève le
 * comportement réel de Stripe : ajout de `merchant` (dashboard=full,
 * fees/losses=stripe), combinaisons invalides, ToS, requirements, SEPA après
 * merchant, mutabilité de `dashboard`. Aucun secret n'est affiché.
 *
 * Usage : npx tsx scripts/spikes/cod/s1-sandbox.ts [--out <fichier.json>]
 */
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import Stripe from 'stripe'
import { StripeApiProvider } from '../../../apps/api/src/modules/payments/infrastructure/stripe-provider.js'

process.loadEnvFile('.env')
const key = process.env.STRIPE_SECRET_KEY ?? ''
if (!/^(sk|rk)_test_/.test(key)) {
  console.error('Abandon : STRIPE_SECRET_KEY absente ou pas une clé Sandbox (sk_test_/rk_test_).')
  process.exit(1)
}
const outIndex = process.argv.indexOf('--out')
const outFile = outIndex > 0 ? process.argv[outIndex + 1] : undefined

const stripe = new Stripe(key, { timeout: 30_000, maxNetworkRetries: 1 })
const provider = new StripeApiProvider(key, 'whsec_unused_in_spike', stripe)
const results: Record<string, unknown> = {}
const INCLUDE = ['configuration.customer', 'configuration.merchant', 'defaults', 'identity', 'requirements'] as const

function compactAccount(a: any): Record<string, unknown> {
  const entries = a?.requirements?.entries ?? []
  return {
    id: a?.id,
    livemode: a?.livemode,
    dashboard: a?.dashboard,
    applied_configurations: a?.applied_configurations,
    responsibilities: a?.defaults?.responsibilities,
    card_payments: a?.configuration?.merchant?.capabilities?.card_payments ?? null,
    cartes_bancaires: a?.configuration?.merchant?.capabilities?.cartes_bancaires_payments ?? null,
    customer_applied: a?.configuration?.customer?.applied ?? null,
    requirements_count: entries.length,
    requirements_first: entries.slice(0, 12).map((e: any) => `${e?.description ?? e?.reference ?? e?.id ?? '?'}|${e?.awaiting_action_from ?? ''}|${(e?.errors ?? []).map((x: any) => x?.code).join(',')}`),
    minimum_deadline: a?.requirements?.summary?.minimum_deadline ?? null,
    identity_country: a?.identity?.country,
    entity_type: a?.identity?.entity_type
  }
}

function compactError(e: any): Record<string, unknown> {
  if (e?.cause !== undefined && e?.cause !== null) {
    return { ...compactError(e.cause), wrappedBy: e?.constructor?.name }
  }
  return {
    ERROR: true,
    type: e?.type ?? e?.constructor?.name,
    code: e?.code ?? e?.raw?.code,
    status: e?.statusCode,
    param: e?.param ?? e?.raw?.param,
    message: String(e?.message ?? e).slice(0, 400),
    requestId: e?.requestId
  }
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const value = await fn()
    results[name] = value
    console.log(`\n## ${name}\n${JSON.stringify(value, null, 1)}`)
    return value
  } catch (e) {
    results[name] = compactError(e)
    console.log(`\n## ${name}\n${JSON.stringify(results[name], null, 1)}`)
    return undefined
  }
}

const details = {
  email: 'spike-cod@example.com',
  legalName: 'Spike COD Restaurant SARL',
  address: { line1: '1 Rue de la République', line2: 'Bât. A', city: 'Bourg-en-Bresse', postalCode: '01000', countryCode: 'FR' }
}

/** Crée un compte comme la prod : customer-only + updateCustomerAccount. */
async function createProdLikeAccount(label: string): Promise<string> {
  const merchantId = randomUUID()
  const { id } = await provider.createCustomerAccount({ merchantId })
  await provider.updateCustomerAccount(id, { ...details, legalName: `${details.legalName} ${label}` })
  return id
}

const merchantParams = (fees: string, losses: string, dashboard: string) => ({
  dashboard,
  defaults: { responsibilities: { fees_collector: fees, losses_collector: losses } },
  configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
  include: [...INCLUDE]
})

async function main(): Promise<void> {
  // D0 — bug suspecté : updateCustomerAccount envoie line2 '' quand la ligne est absente
  await step('D0a provider.updateCustomerAccount avec line2 vide (comportement prod)', async () => {
    const { id } = await provider.createCustomerAccount({ merchantId: randomUUID() })
    await provider.updateCustomerAccount(id, { ...details, address: { ...details.address, line2: '' } })
    return { ok: true, id }
  })
  await step('D0b update SDK brut avec line2 OMISE', async () => {
    const { id } = await provider.createCustomerAccount({ merchantId: randomUUID() })
    await (stripe.v2.core.accounts as any).update(id, {
      contact_email: details.email, display_name: details.legalName,
      identity: { country: 'fr', entity_type: 'company', business_details: { registered_name: details.legalName, address: { line1: details.address.line1, city: details.address.city, postal_code: details.address.postalCode, country: 'fr' } } }
    })
    return { ok: true, id }
  })

  // A — compte prod-like, ajout merchant full/stripe/stripe
  const a = await step('A0 création prod-like (customer-only)', async () => {
    const id = await createProdLikeAccount('A')
    const acc = await (stripe.v2.core.accounts as any).retrieve(id, { include: [...INCLUDE] })
    return compactAccount(acc)
  }) as { id: string } | undefined
  if (a === undefined) return

  const addMerchant = await step('A1 update: ajout merchant full/stripe/stripe (sans ToS)', async () =>
    compactAccount(await (stripe.v2.core.accounts as any).update(a.id, merchantParams('stripe', 'stripe', 'full'))))

  if (addMerchant !== undefined && (addMerchant as any).ERROR === true) {
    await step('A1b update: idem AVEC attestation ToS (Sandbox seulement)', async () =>
      compactAccount(await (stripe.v2.core.accounts as any).update(a.id, {
        ...merchantParams('stripe', 'stripe', 'full'),
        identity: { attestations: { terms_of_service: { account: { date: new Date().toISOString(), ip: '203.0.113.7', user_agent: 'spike-s1' } } } }
      })))
  }

  await step('A2 retrieve après merchant', async () =>
    compactAccount(await (stripe.v2.core.accounts as any).retrieve(a.id, { include: [...INCLUDE] })))

  // Lien d'onboarding hébergé v2 (le lien expire vite ; usage manuel éventuel)
  await step('A3 account link v2 merchant', async () => {
    const link = await (stripe.v2.core as any).accountLinks.create({
      account: a.id,
      use_case: { type: 'account_onboarding', account_onboarding: { configurations: ['merchant'], return_url: 'https://example.com/return', refresh_url: 'https://example.com/refresh' } }
    })
    return { created: link.created, expires_at: link.expires_at, url_host: new URL(link.url).host, url: link.url }
  })

  // U2/U15 (avant KYC complet) : SEPA après merchant + updateCustomerAccount rejoué
  await step('A4 updateCustomerAccount rejoué après merchant', async () => {
    await provider.updateCustomerAccount(a.id, { ...details, legalName: `${details.legalName} A RENAMED`, address: { ...details.address, line1: '2 Rue Neuve' } })
    return compactAccount(await (stripe.v2.core.accounts as any).retrieve(a.id, { include: [...INCLUDE] }))
  })
  await step('A5 SetupIntent SEPA après merchant + confirmation IBAN test', async () => {
    const si = await provider.createSetupIntent({ customerAccountId: a.id, merchantId: randomUUID() })
    const confirmed = await stripe.setupIntents.confirm(si.setupIntentId, {
      payment_method_data: { type: 'sepa_debit', sepa_debit: { iban: 'FR1420041010050500013M02606' }, billing_details: { name: details.legalName, email: details.email } },
      mandate_data: { customer_acceptance: { type: 'online', online: { ip_address: '203.0.113.7', user_agent: 'spike-s1' } } }
    })
    return { setupIntent: confirmed.status, hasMandate: typeof confirmed.mandate === 'string', paymentMethod: typeof confirmed.payment_method === 'string' }
  })

  // U12 : dashboard modifiable ? responsabilités modifiables ?
  await step('A6 update dashboard full→none', async () =>
    compactAccount(await (stripe.v2.core.accounts as any).update(a.id, { dashboard: 'none', include: [...INCLUDE] })))
  await step('A7 update responsabilités après ajout', async () =>
    compactAccount(await (stripe.v2.core.accounts as any).update(a.id, { defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'application' } }, include: [...INCLUDE] })))

  // U16 : combinaisons invalides, un compte jetable chacune
  const invalid: Array<[string, string, string]> = [
    ['full', 'application', 'application'],
    ['express', 'stripe', 'stripe'],
    ['full', 'stripe', 'application']
  ]
  for (const [dashboard, fees, losses] of invalid) {
    await step(`B combo invalide dashboard=${dashboard} fees=${fees} losses=${losses}`, async () => {
      const id = await createProdLikeAccount(`B-${dashboard}-${fees}-${losses}`)
      return compactAccount(await (stripe.v2.core.accounts as any).update(id, merchantParams(fees, losses, dashboard)))
    })
  }

  // Référence : none/stripe/stripe (pour la comparaison D4)
  await step('C none/stripe/stripe (référence)', async () => {
    const id = await createProdLikeAccount('C-none')
    return compactAccount(await (stripe.v2.core.accounts as any).update(id, merchantParams('stripe', 'stripe', 'none')))
  })

  if (outFile !== undefined) writeFileSync(outFile, JSON.stringify(results, null, 2))
}

main().catch((e) => { console.error(compactError(e)); process.exit(1) })
