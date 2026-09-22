/**
 * T40b — prépare (ou nettoie) une commande COD « COLLECTED » pour le test sur téléphone.
 * DB locale de dev uniquement. Le restaurant de test est lié au compte Sandbox A (jamais le compte SEPA existant).
 *
 *   npx tsx scripts/e2e/cod-device-fixture.ts <poc-accounts.json>            # crée + affiche id et code
 *   npx tsx scripts/e2e/cod-device-fixture.ts <poc-accounts.json> --cleanup  # supprime tout
 */
import { readFileSync } from 'node:fs'

process.loadEnvFile('.env')
const FORBIDDEN = new Set(['acct_1UHTimJwc2CYzaPJ'])
const state = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as { createdBy?: string; A?: string }
if (state.createdBy !== 's1c' || !state.A || FORBIDDEN.has(state.A)) { console.error('État invalide.'); process.exit(1) }
const cleanupOnly = process.argv.includes('--cleanup')
const keep = process.argv.includes('--keep') // ajoute une commande sans supprimer les précédentes

const [{ pool }, { createOrdersModule }, { deleteTestOrders }] = await Promise.all([
  import('../../apps/api/src/platform/db.js'),
  import('../../apps/api/src/modules/orders/public.js'),
  import('../../apps/api/test/support/cleanup-orders.js')
])
const DRIVER = '33333333-3333-3333-3333-333333333333'
const SOURCE_MERCHANT = '22222222-2222-2222-2222-222222222222'
const MERCHANT = 'e2e00000-0000-4000-8000-0000000000d1'
const orders = createOrdersModule(pool, process.env.OSRM_URL ?? 'http://localhost:5000', async () => ({ lat: 46.2, lng: 5.2 }), undefined, { increment: async () => undefined, decrement: async () => undefined })

async function cleanup(): Promise<void> {
  const ids = (await pool.query<{ id: string }>('select id from orders where merchant_id = $1', [MERCHANT])).rows.map((r) => r.id)
  await deleteTestOrders(pool, ids)
  for (const table of ['merchant_terminal_locations', 'merchant_stripe_connect', 'merchant_payment_profiles']) {
    await pool.query(`delete from ${table} where merchant_id = $1`, [MERCHANT])
  }
  await pool.query('delete from merchants where id = $1', [MERCHANT])
}

try {
  if (!keep) await cleanup()
  if (!cleanupOnly) {
    const src = (await pool.query('select * from merchants where id = $1', [SOURCE_MERCHANT])).rows[0]
    const columns = Object.keys(src).filter((c) => c !== 'id')
    const values = columns.map((c) => (c === 'name' ? 'Restaurant Test COD' : c === 'email' ? 'e2e-device@example.invalid' : src[c]))
    if (!keep) await pool.query(`insert into merchants (id, ${columns.map((c) => `"${c}"`).join(', ')}) values ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')})`, [MERCHANT, ...values])
    if (!keep) await pool.query("insert into merchant_legal_information (merchant_id, siret, siren, legal_name, legal_address_line1, legal_address_postal_code, legal_address_city, sirene_verification_status) values ($1, '12345678901234', '123456789', 'Restaurant Test COD', '1 Rue de la République', '01000', 'Bourg-en-Bresse', 'unverified')", [MERCHANT])
    if (!keep) await pool.query('insert into merchant_payment_profiles (merchant_id, stripe_account_id) values ($1, $2)', [MERCHANT, state.A])
    const m = (await pool.query('select id, name, zone_id, address from merchants where id = $1', [MERCHANT])).rows[0]
    const made = await orders.createOrder({
      merchant: { id: m.id, name: m.name, zoneId: m.zone_id, address: m.address, phonePrimary: '0', phoneSecondary: null, logoUrl: null, lat: 46.2, lng: 5.2, onboardingCompleted: true },
      zone: { id: m.zone_id, name: 'z', centerLat: 46.2, centerLng: 5.2, radiusKm: 10 },
      customerName: 'Client Test', customerPhone: '0600000000', deliveryAddress: '1 Rue Test, Bourg-en-Bresse', deliveryLat: 46.21, deliveryLng: 5.21,
      pickupScheduledAt: { mode: 'asap' }, cashOnDelivery: { amountCents: 5000 }
    })
    const assigned = await orders.assignOrder({ orderId: made.id, driverId: DRIVER, expectedVersion: made.version, actor: { type: 'driver', id: DRIVER } })
    await orders.collectOrder({ orderId: made.id, driverId: DRIVER, expectedVersion: assigned.version, actor: { type: 'driver', id: DRIVER } })
    const code = (await orders.getMerchantOrders(MERCHANT)).find((o) => o.id === made.id)?.deliveryCode
    console.log(`COMMANDE ${made.id}\nCODE LIVRAISON ${code}\nMONTANT 50,00 EUR (restaurant lié au compte Sandbox A)`)
  } else {
    console.log('Fixture supprimée.')
  }
} finally {
  await pool.end()
}
