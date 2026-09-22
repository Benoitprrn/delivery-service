// R90 — assemblage des cas d'usage réels (Stripe Sandbox réel, PostgreSQL R90 réel, horloge injectée, e-mail simulé).
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { REPO, RUN_ID, guardStripeId, log, newPool, sandboxStripe } from './lib.mts'

export const S: any = await import(`${REPO}/apps/api/src/modules/settlements/public.ts`)
const { PostgresOrderRepository } = await import(`${REPO}/apps/api/src/modules/orders/infrastructure/postgres-order-repository.ts`)
const { createPaymentsModule, createStripeProvider } = await import(`${REPO}/apps/api/src/modules/payments/public.ts`)

export const stripe = sandboxStripe()
export const pool = newPool()
export const silent = { debug() {}, info() {}, warn(o: unknown, m: string) { log('WARN ' + m, o) }, error(o: unknown, m: string) { log('ERROR ' + m, o) } }
export const state = JSON.parse(fs.readFileSync(`${REPO}/docs/work/r90/evidence/state-${RUN_ID}.json`, 'utf8'))
export const payments = createPaymentsModule(pool, createStripeProvider(false, undefined, undefined), async () => null, async () => null)
export const orderRepo = new PostgresOrderRepository(pool)

/** E-mails simulés : conservés pour preuve (aucun envoi réel). */
export const sentEmails: any[] = []
export const fakeEmail = { send: async (m: any) => { sentEmails.push(m); return { provider: 'fake-r90', messageId: 'm-' + randomUUID() } } }
export const preNotifier = () => new S.SendPreNotificationsUseCase(new S.PostgresPreNotificationRepository(pool), {
  read: async (merchantId: string) => ({ email: `r90-${merchantId.slice(-2)}@example.test`, legalName: (await pool.query('select name from merchants where id = $1::uuid', [merchantId])).rows[0].name, activeSepaMethod: await payments.findActiveSepaMandate(merchantId) }),
}, fakeEmail, { creditorId: 'SANDBOX-CREDITOR', supportEmail: 'support@example.test' }, silent)

export const debitProvider = new S.StripeSepaDebitProvider(stripe, false)
export const sepaUseCase = (provider: any = debitProvider) => new S.RunSepaDebitsUseCase(new S.PostgresSepaDebitRepository(pool), { findActive: payments.findActiveSepaDebitSource }, provider, silent, { syncIntervalSeconds: 10, retryDelaySeconds: 10 })
export const transferProvider = new S.StripeDriverTransferProvider(stripe, false)
export const liveReader = { isTransferReady: async (id: string) => (await stripe.accounts.retrieve(id)).capabilities?.transfers === 'active' }
export const payoutUseCase = (transfers: any = transferProvider, debits: any = debitProvider) => new S.RunDriverPayoutsUseCase(new S.PostgresDriverPayoutRepository(pool), debits, transfers, liveReader, silent, { recheckDelaySeconds: 30 })
export const closeUseCase = () => new S.CloseSettlementPeriodUseCase(new S.PostgresSettlementCloseRepository(pool), orderRepo)
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export { guardStripeId }
