import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { pool } from '../../src/platform/db.js'
import { MAX_DETACH_ATTEMPTS } from '../../src/modules/payments/ports/payment-repository.js'
import { PostgresPaymentRepository } from '../../src/modules/payments/infrastructure/postgres-payment-repository.js'
import { CompleteSepaSetupIntentUseCase, HandleStripeWebhookUseCase, UnknownSetupIntentError } from '../../src/modules/payments/application/sepa-payment-method.js'
import { ReconcileDetachmentsUseCase } from '../../src/modules/payments/application/reconcile-detachments.js'
import type { StripeProvider } from '../../src/modules/payments/ports/stripe-provider.js'
import type Stripe from 'stripe'
import { StripeResourceMissingError } from '../../src/modules/payments/ports/stripe-provider.js'
import Fastify from 'fastify'
import rawBody from 'fastify-raw-body'
import StripeClient from 'stripe'
import { registerCorrelationId } from '../../src/platform/correlation-id.js'
import { registerAuthentication } from '../../src/modules/auth/transport/http/authentication-hook.js'
import { createPaymentsModule, createStripeProvider, startStripePaymentsWorker } from '../../src/modules/payments/public.js'
import { buildApp } from '../../src/app.js'
import { StripeApiProvider } from '../../src/modules/payments/infrastructure/stripe-provider.js'

const repository = new PostgresPaymentRepository(pool)
const merchantIds: string[] = []

function eventId(): string { return `evt_test_${randomUUID()}` }
async function merchant(): Promise<string> { const id = randomUUID(); merchantIds.push(id); await pool.query('insert into merchants(id, name) values ($1, $2)', [id, `Merchant payments ${id}`]); return id }
async function paymentMethod(merchantId: string, status: 'setup_pending' | 'active' | 'invalid' | 'detach_pending' | 'detached', stripePaymentMethodId: string | null = null): Promise<{ setupIntentId: string; paymentMethodId: string | null }> { const setupIntentId = `seti_test_${randomUUID()}`; const result = await pool.query<{ stripe_payment_method_id: string | null }>(`insert into merchant_payment_methods(merchant_id, stripe_setup_intent_id, stripe_payment_method_id, status) values ($1, $2, $3, $4) returning stripe_payment_method_id`, [merchantId, setupIntentId, stripePaymentMethodId, status]); return { setupIntentId, paymentMethodId: result.rows[0]!.stripe_payment_method_id } }
async function webhook(id = eventId()): Promise<string> { await repository.recordWebhookEvent({ eventId: id, eventType: 'setup_intent.succeeded', objectId: `seti_${id}`, merchantId: null, objectStatus: null }); return id }
async function webhookState(id: string) { return pool.query<{ status: string; attempts: number; last_error: string | null; next_attempt_at: Date; processing_token: string | null }>('select status, attempts, last_error, next_attempt_at, processing_token from stripe_webhook_events where event_id = $1', [id]) }

class QueueStripe implements StripeProvider {
  reads = 0; detaches = 0; failDetachOnce = false; missing = false
  intents = new Map<string, { id: string; customer_account: string; status: string; metadata: { merchant_id: string }; payment_method: string; mandate: string }>()
  async createCustomerAccount(): Promise<{ id: string }> { return { id: 'acct_queue' } }; async hasMerchantConfiguration(): Promise<boolean> { return false }; async updateCustomerAccount(): Promise<void> {}; async createSetupIntent(): Promise<{ setupIntentId: string; clientSecret: string }> { throw new Error('not used') }
  async retrieveSetupIntent(id: string): Promise<Stripe.SetupIntent> { this.reads++; return this.intents.get(id) as unknown as Stripe.SetupIntent }
  async retrievePaymentMethod(id: string): Promise<Stripe.PaymentMethod> { return { id, type: 'sepa_debit', customer_account: 'acct_queue', sepa_debit: { last4: '6789', country: 'FR' } } as unknown as Stripe.PaymentMethod }
  async retrieveMandate(id: string): Promise<Stripe.Mandate> { return { id, payment_method: `pm_${id.slice(8)}`, payment_method_details: { sepa_debit: { reference: 'LOCAL' } } } as unknown as Stripe.Mandate }
  async detachPaymentMethod(): Promise<void> { this.detaches++; if (this.missing) throw new StripeResourceMissingError(); if (this.failDetachOnce) { this.failDetachOnce = false; throw new Error('local detach failure') } }
  constructEvent(): Stripe.Event { throw new Error('not used') }
}
function stripeEvent(id: string, type: string, object: Record<string, unknown>): Stripe.Event { return { id, type, data: { object } } as unknown as Stripe.Event }

beforeAll(async () => {
  const result = await pool.query<{ event_id: string }>(`
    select event_id
    from stripe_webhook_events
    where event_id not like 'evt_test_%'
      and (
        status in ('pending', 'failed')
        or (status = 'processing' and processing_started_at < now() - interval '5 minutes')
      )
    limit 1
  `)
  if (result.rows[0] !== undefined) throw new Error(`Non-test claimable Stripe webhook event present: ${result.rows[0].event_id}`)
})

beforeAll(async () => {
  const probeId = eventId()
  try {
    await repository.recordWebhookEvent({ eventId: probeId, eventType: 'setup_intent.succeeded', objectId: `seti_${probeId}`, merchantId: null, objectStatus: null })
    await new Promise<void>((resolve) => { setTimeout(resolve, 2_500) })
    const state = (await webhookState(probeId)).rows[0]
    if (state === undefined || state.status !== 'pending' || state.attempts !== 0) {
      throw new Error('Un worker externe consomme stripe_webhook_events (serveur de dev avec STRIPE_PAYMENTS_ENABLED=true ?). Exécutez ce fichier avec DATABASE_URL pointant vers une base dédiée.')
    }
  } finally {
    await pool.query('delete from stripe_webhook_events where event_id = $1', [probeId])
  }
}, 10_000)

afterEach(async () => {
  await pool.query("delete from stripe_webhook_events where event_id like 'evt_test_%'")
  if (merchantIds.length > 0) await pool.query('delete from merchants where id = any($1::uuid[])', [merchantIds.splice(0)])
})

describe('PostgresPaymentRepository', () => {
  it('prefers an active display method over a recent invalid attempt without a payment method', async () => {
    const merchantId = await merchant()
    await paymentMethod(merchantId, 'active', `pm_${randomUUID()}`)
    await paymentMethod(merchantId, 'invalid')
    expect((await repository.findDisplayMethod(merchantId))?.status).toBe('active')
  })

  it('prefers an active display method over an older invalid payment method', async () => {
    const merchantId = await merchant()
    await paymentMethod(merchantId, 'invalid', `pm_${randomUUID()}`)
    await paymentMethod(merchantId, 'active', `pm_${randomUUID()}`)
    expect((await repository.findDisplayMethod(merchantId))?.status).toBe('active')
  })

  it('uses an invalid display method only when it has a Stripe payment method', async () => {
    const merchantId = await merchant()
    const paymentMethodId = `pm_${randomUUID()}`
    await paymentMethod(merchantId, 'invalid', paymentMethodId)
    expect((await repository.findDisplayMethod(merchantId))?.stripePaymentMethodId).toBe(paymentMethodId)
  })

  it('does not display an invalid setup attempt without a Stripe payment method', async () => {
    const merchantId = await merchant()
    await paymentMethod(merchantId, 'invalid')
    expect(await repository.findDisplayMethod(merchantId)).toBeNull()
  })

  it('enforces one active method and atomically replaces it', async () => {
    const merchantId = await merchant()
    const active = await paymentMethod(merchantId, 'active', `pm_${randomUUID()}`)
    await expect(paymentMethod(merchantId, 'active', `pm_${randomUUID()}`)).rejects.toThrow()
    const pending = await paymentMethod(merchantId, 'setup_pending')
    const details = { stripePaymentMethodId: `pm_${randomUUID()}`, stripeMandateId: `mandate_${randomUUID()}`, bankName: null, last4: '1234', country: 'FR', mandateReference: null }
    const activated = await repository.activate(pending.setupIntentId, details)
    expect(activated.active.status).toBe('active')
    expect(activated.previous?.setupIntentId).toBe(active.setupIntentId)
    const statuses = await pool.query<{ status: string }>('select status from merchant_payment_methods where merchant_id = $1 order by stripe_setup_intent_id', [merchantId])
    expect(statuses.rows.map(row => row.status).sort()).toEqual(['active', 'detach_pending'])
    expect((await repository.activate(pending.setupIntentId, details)).active.status).toBe('active')
  })

  it('deduplicates concurrent webhook receipts and never reopens a processed event', async () => {
    const id = eventId()
    await Promise.all(Array.from({ length: 10 }, () => webhook(id)))
    expect((await pool.query('select event_id from stripe_webhook_events where event_id = $1', [id])).rowCount).toBe(1)
    const claim = await repository.claimNextWebhookEvent()
    expect(claim?.event.eventId).toBe(id)
    expect(await repository.completeWebhookEvent(id, claim!.token)).toBe(true)
    await webhook(id)
    expect((await webhookState(id)).rows[0]?.status).toBe('processed')
  })

  it('allows exactly one concurrent webhook claim and safely reclaims an expired lease', async () => {
    const id = await webhook()
    const claims = await Promise.all(Array.from({ length: 5 }, () => repository.claimNextWebhookEvent()))
    const first = claims.filter((claim): claim is NonNullable<typeof claim> => claim !== null)
    expect(first).toHaveLength(1)
    await pool.query("update stripe_webhook_events set processing_started_at = now() - interval '6 minutes' where event_id = $1", [id])
    const reclaimed = await repository.claimNextWebhookEvent()
    expect(reclaimed?.token).not.toBe(first[0]!.token)
    expect(await repository.completeWebhookEvent(id, first[0]!.token)).toBe(false)
    expect(await repository.failWebhookEvent({ eventId: id, token: first[0]!.token, errorClass: 'OldWorkerError' })).toBe(false)
    expect(await repository.completeWebhookEvent(id, reclaimed!.token)).toBe(true)
    expect(await repository.claimNextWebhookEvent()).toBeNull()
  })

  it('backs off webhook failures, dead-letters at the maximum, and does not block later due work', async () => {
    const firstId = await webhook()
    const firstClaim = await repository.claimNextWebhookEvent()
    expect(await repository.failWebhookEvent({ eventId: firstId, token: firstClaim!.token, errorClass: 'RetryableError' })).toBe(true)
    const failed = (await webhookState(firstId)).rows[0]!
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, last_error: 'RetryableError' })
    expect(failed.next_attempt_at.getTime()).toBeGreaterThan(Date.now())
    expect(await repository.claimNextWebhookEvent()).toBeNull()
    await pool.query("update stripe_webhook_events set next_attempt_at = now() - interval '1 second' where event_id = $1", [firstId])
    expect((await repository.claimNextWebhookEvent())?.event.eventId).toBe(firstId)
    await pool.query("update stripe_webhook_events set status = 'processing', attempts = 19, processing_token = gen_random_uuid(), processing_started_at = now() where event_id = $1", [firstId])
    const token = (await webhookState(firstId)).rows[0]!.processing_token!
    expect(await repository.failWebhookEvent({ eventId: firstId, token, errorClass: 'FinalError' })).toBe(true)
    expect((await webhookState(firstId)).rows[0]?.status).toBe('dead_letter')
    const blockedId = await webhook()
    await pool.query("update stripe_webhook_events set status = 'failed', next_attempt_at = now() + interval '1 hour' where event_id = $1", [blockedId])
    const dueId = await webhook()
    expect((await repository.claimNextWebhookEvent())?.event.eventId).toBe(dueId)
  })

  it('claims detach reconciliation once, reclaims an expired lease, and records a token-guarded failure', async () => {
    const merchantId = await merchant()
    const stripePaymentMethodId = `pm_${randomUUID()}`
    await paymentMethod(merchantId, 'detach_pending', stripePaymentMethodId)
    const claims = await Promise.all([repository.claimDetachPending(1), repository.claimDetachPending(1)])
    const first = claims.flat()
    expect(first).toHaveLength(1)
    expect(await repository.claimDetachPending(1)).toEqual([])
    await pool.query("update merchant_payment_methods set detach_locked_until = now() - interval '1 second' where stripe_payment_method_id = $1", [stripePaymentMethodId])
    const reclaimed = (await repository.claimDetachPending(1))[0]!
    expect(reclaimed.token).not.toBe(first[0]!.token)
    expect(await repository.recordDetachFailure({ paymentMethodId: stripePaymentMethodId, token: '00000000-0000-0000-0000-000000000000', errorClass: 'DetachError' })).toBe(false)
    expect(await repository.recordDetachFailure({ paymentMethodId: stripePaymentMethodId, token: reclaimed.token, errorClass: 'DetachError' })).toBe(true)
    const row = await pool.query<{ detach_attempts: number; detach_next_attempt_at: Date | null; detach_locked_until: Date | null; detach_processing_token: string | null }>('select detach_attempts, detach_next_attempt_at, detach_locked_until, detach_processing_token from merchant_payment_methods where stripe_payment_method_id = $1', [stripePaymentMethodId])
    expect(row.rows[0]).toMatchObject({ detach_attempts: 1, detach_locked_until: null, detach_processing_token: null })
    expect(row.rows[0]!.detach_next_attempt_at!.getTime()).toBeGreaterThan(Date.now())
  })

  it('leaves an exhausted detach pending method unclaimable and marks only its matching Stripe method detached', async () => {
    const merchantId = await merchant()
    const oldPaymentMethodId = `pm_${randomUUID()}`
    const activePaymentMethodId = `pm_${randomUUID()}`
    await paymentMethod(merchantId, 'detach_pending', oldPaymentMethodId)
    await paymentMethod(merchantId, 'active', activePaymentMethodId)
    await pool.query('update merchant_payment_methods set detach_attempts = $2, detach_next_attempt_at = null where stripe_payment_method_id = $1', [oldPaymentMethodId, MAX_DETACH_ATTEMPTS])
    expect(await repository.claimDetachPending(10)).toEqual([])
    await repository.markDetached(oldPaymentMethodId)
    await repository.markDetached(oldPaymentMethodId)
    const rows = await pool.query<{ stripe_payment_method_id: string; status: string }>('select stripe_payment_method_id, status from merchant_payment_methods where merchant_id = $1', [merchantId])
    expect(rows.rows).toEqual(expect.arrayContaining([{ stripe_payment_method_id: oldPaymentMethodId, status: 'detached' }, { stripe_payment_method_id: activePaymentMethodId, status: 'active' }]))
    await repository.markDetached(activePaymentMethodId)
    expect((await pool.query<{ status: string }>('select status from merchant_payment_methods where stripe_payment_method_id = $1', [activePaymentMethodId])).rows[0]?.status).toBe('invalid')
  })

  it('makes absent mandate and payment method updates harmless no-ops', async () => {
    await expect(repository.markMandateInactive(`mandate_${randomUUID()}`)).resolves.toBeUndefined()
    await expect(repository.markDetached(`pm_${randomUUID()}`)).resolves.toBeUndefined()
  })

  it('durably receives a webhook before processing it, then activates the matching pending method', async () => {
    const merchantId = await merchant(); const setupIntentId = `seti_test_${randomUUID()}`
    await pool.query('insert into merchant_payment_profiles(merchant_id, stripe_account_id) values ($1, $2)', [merchantId, 'acct_queue'])
    await paymentMethod(merchantId, 'setup_pending')
    await pool.query('update merchant_payment_methods set stripe_setup_intent_id = $1 where merchant_id = $2', [setupIntentId, merchantId])
    const stripe = new QueueStripe(); stripe.intents.set(setupIntentId, { id: setupIntentId, customer_account: 'acct_queue', status: 'succeeded', metadata: { merchant_id: merchantId }, payment_method: `pm_${setupIntentId}`, mandate: `mandate_${setupIntentId}` })
    const complete = new CompleteSepaSetupIntentUseCase(repository, stripe); const webhookUseCase = new HandleStripeWebhookUseCase(repository, complete); const id = eventId()
    await webhookUseCase.receive(stripeEvent(id, 'setup_intent.succeeded', { id: setupIntentId, metadata: { merchant_id: merchantId } }))
    expect((await webhookState(id)).rows[0]).toMatchObject({ status: 'pending', attempts: 0 }); expect(stripe.reads).toBe(0)
    await webhookUseCase.processBatch(); expect((await webhookState(id)).rows[0]?.status).toBe('processed'); expect((await repository.findActive(merchantId))?.setupIntentId).toBe(setupIntentId)
  })

  it('keeps terminal invalid setup events processed, retries unknown intents, and dead-letters their twentieth failure', async () => {
    const merchantId = await merchant(); const invalid = await paymentMethod(merchantId, 'invalid'); const stripe = new QueueStripe(); const webhookUseCase = new HandleStripeWebhookUseCase(repository, new CompleteSepaSetupIntentUseCase(repository, stripe))
    const terminalId = eventId(); await webhookUseCase.receive(stripeEvent(terminalId, 'setup_intent.succeeded', { id: invalid.setupIntentId })); await webhookUseCase.processBatch(); expect((await webhookState(terminalId)).rows[0]?.status).toBe('processed')
    const unknownId = eventId(); await webhookUseCase.receive(stripeEvent(unknownId, 'setup_intent.succeeded', { id: `seti_unknown_${randomUUID()}` })); await webhookUseCase.processBatch(); expect((await webhookState(unknownId)).rows[0]).toMatchObject({ status: 'failed', last_error: UnknownSetupIntentError.name })
    await pool.query("update stripe_webhook_events set attempts = 19, status = 'failed', next_attempt_at = now() - interval '1 second' where event_id = $1", [unknownId]); await webhookUseCase.processBatch(); expect((await webhookState(unknownId)).rows[0]?.status).toBe('dead_letter')
  })

  it('retries a failed detachment at its database-controlled next attempt and treats missing Stripe resources as detached', async () => {
    const merchantId = await merchant(); const pm = `pm_${randomUUID()}`; await paymentMethod(merchantId, 'detach_pending', pm); const stripe = new QueueStripe(); stripe.failDetachOnce = true; const reconcile = new ReconcileDetachmentsUseCase(repository, stripe)
    await reconcile.run(); const failed = await pool.query<{ detach_attempts: number; detach_next_attempt_at: Date }>('select detach_attempts, detach_next_attempt_at from merchant_payment_methods where stripe_payment_method_id = $1', [pm]); expect(failed.rows[0]!.detach_attempts).toBe(1); expect(failed.rows[0]!.detach_next_attempt_at.getTime()).toBeGreaterThan(Date.now())
    await pool.query("update merchant_payment_methods set detach_next_attempt_at = now() - interval '1 second' where stripe_payment_method_id = $1", [pm]); await reconcile.run(); expect((await pool.query<{ status: string }>('select status from merchant_payment_methods where stripe_payment_method_id = $1', [pm])).rows[0]?.status).toBe('detached')
    const missingPm = `pm_${randomUUID()}`; await paymentMethod(merchantId, 'detach_pending', missingPm); stripe.missing = true; await reconcile.run(); expect((await pool.query<{ status: string }>('select status from merchant_payment_methods where stripe_payment_method_id = $1', [missingPm])).rows[0]?.status).toBe('detached')
  })

  it('assembles the HTTP webhook endpoint with real local Stripe signature verification and durable receipt', async () => {
    const localKey = 'local-only-key-placeholder'; const localSigningValue = 'local-only-signing-value'; const client = new StripeClient(localKey)
    const payments = createPaymentsModule(pool, new StripeApiProvider(localKey, localSigningValue, client), async () => null, async () => null)
    const app = Fastify({ logger: false }); registerCorrelationId(app)
    registerAuthentication(app, { verifier: { verify: async () => ({ id: randomUUID(), role: 'merchant', email: 'local@example.test' }) } })
    await app.register(rawBody, { field: 'rawBody', global: false, encoding: 'utf8', runFirst: true }); await app.register((await import('../../src/modules/payments/transport/http/routes.js')).registerPaymentHttpRoutes, { payments })
    const id = eventId(); const payload = JSON.stringify({ id, type: 'setup_intent.succeeded', data: { object: { id: `seti_${id}` } } }); const signature = client.webhooks.generateTestHeaderString({ payload, secret: localSigningValue }); const headers = { 'content-type': 'application/json', 'stripe-signature': signature }
    try {
      expect((await app.inject({ method: 'POST', url: '/api/v1/webhooks/stripe', payload, headers: { 'content-type': 'application/json' } })).statusCode).toBe(400)
      expect((await app.inject({ method: 'POST', url: '/api/v1/webhooks/stripe', payload, headers: { ...headers, 'stripe-signature': 'v1=local-invalid' } })).statusCode).toBe(400)
      const valid = await app.inject({ method: 'POST', url: '/api/v1/webhooks/stripe', payload, headers }); expect(valid.statusCode).toBe(200); expect(valid.body).not.toContain('clientSecret'); expect((await webhookState(id)).rows[0]).toMatchObject({ status: 'pending', attempts: 0 })
      expect((await app.inject({ method: 'POST', url: '/api/v1/webhooks/stripe', payload, headers })).statusCode).toBe(200); expect((await pool.query('select event_id from stripe_webhook_events where event_id = $1', [id])).rowCount).toBe(1)
      expect((await app.inject({ method: 'POST', url: '/api/v1/webhooks/stripe', payload: `${payload} `, headers })).statusCode).toBe(400)
    } finally { await app.close() }
    const unavailablePayments = createPaymentsModule(pool, createStripeProvider(false, localKey, localSigningValue), async () => null, async () => null)
    const unavailable = Fastify({ logger: false }); registerCorrelationId(unavailable); registerAuthentication(unavailable, { verifier: { verify: async () => ({ id: randomUUID(), role: 'merchant', email: 'local@example.test' }) } }); await unavailable.register(rawBody, { field: 'rawBody', global: false, encoding: 'utf8', runFirst: true }); await unavailable.register((await import('../../src/modules/payments/transport/http/routes.js')).registerPaymentHttpRoutes, { payments: unavailablePayments })
    try { const response = await unavailable.inject({ method: 'POST', url: '/api/v1/webhooks/stripe', payload, headers }); expect(response.statusCode).toBe(503); expect(response.body).not.toContain('signature') } finally { await unavailable.close() }
  })
  it('keeps an active method displayed even when an invalid method with a payment method was updated more recently', async () => {
    const merchantId = await merchant()
    const active = await paymentMethod(merchantId, 'active', `pm_${randomUUID()}`)
    await paymentMethod(merchantId, 'invalid', `pm_${randomUUID()}`)
    await pool.query("update merchant_payment_methods set updated_at = now() + interval '1 hour' where merchant_id = $1 and status = 'invalid'", [merchantId])
    expect((await repository.findDisplayMethod(merchantId))?.setupIntentId).toBe(active.setupIntentId)
  })

  async function pendingSucceededSetup(): Promise<{ merchantId: string; setupIntentId: string; stripe: QueueStripe }> {
    const merchantId = await merchant()
    await pool.query('insert into merchant_payment_profiles(merchant_id, stripe_account_id) values ($1, $2)', [merchantId, 'acct_queue'])
    const { setupIntentId } = await paymentMethod(merchantId, 'setup_pending')
    const stripe = new QueueStripe()
    stripe.intents.set(setupIntentId, { id: setupIntentId, customer_account: 'acct_queue', status: 'succeeded', metadata: { merchant_id: merchantId }, payment_method: `pm_${setupIntentId}`, mandate: `mandate_${setupIntentId}` })
    return { merchantId, setupIntentId, stripe }
  }

  async function activeSetupIntents(merchantId: string): Promise<string[]> {
    const result = await pool.query<{ stripe_setup_intent_id: string }>("select stripe_setup_intent_id from merchant_payment_methods where merchant_id = $1 and status = 'active'", [merchantId])
    return result.rows.map((row) => row.stripe_setup_intent_id)
  }

  it('receives ten concurrent deliveries of one event into a single row and processes it exactly once', async () => {
    const { merchantId, setupIntentId, stripe } = await pendingSucceededSetup()
    const useCase = new HandleStripeWebhookUseCase(repository, new CompleteSepaSetupIntentUseCase(repository, stripe))
    const id = eventId()
    const event = stripeEvent(id, 'setup_intent.succeeded', { id: setupIntentId, metadata: { merchant_id: merchantId } })
    await Promise.all(Array.from({ length: 10 }, () => useCase.receive(event)))
    expect((await pool.query('select 1 from stripe_webhook_events where event_id = $1', [id])).rowCount).toBe(1)
    const claimed = await Promise.all([useCase.processBatch(), useCase.processBatch(), useCase.processBatch()])
    expect(claimed.reduce((total, count) => total + count, 0)).toBe(1)
    expect(stripe.reads).toBe(1)
    expect((await webhookState(id)).rows[0]?.status).toBe('processed')
    expect(await activeSetupIntents(merchantId)).toEqual([setupIntentId])
  })

  it('activates exactly one method when the webhook is processed before /complete', async () => {
    const { merchantId, setupIntentId, stripe } = await pendingSucceededSetup()
    const complete = new CompleteSepaSetupIntentUseCase(repository, stripe)
    const useCase = new HandleStripeWebhookUseCase(repository, complete)
    const id = eventId()
    await useCase.receive(stripeEvent(id, 'setup_intent.succeeded', { id: setupIntentId, metadata: { merchant_id: merchantId } }))
    await useCase.processBatch()
    expect(await activeSetupIntents(merchantId)).toEqual([setupIntentId])
    const readsAfterWebhook = stripe.reads
    expect((await complete.execute(merchantId, setupIntentId)).status).toBe('active')
    expect(stripe.reads).toBe(readsAfterWebhook)
    expect((await webhookState(id)).rows[0]?.status).toBe('processed')
    expect(await activeSetupIntents(merchantId)).toEqual([setupIntentId])
  })

  it('activates exactly one method when /complete runs before the webhook', async () => {
    const { merchantId, setupIntentId, stripe } = await pendingSucceededSetup()
    const complete = new CompleteSepaSetupIntentUseCase(repository, stripe)
    const useCase = new HandleStripeWebhookUseCase(repository, complete)
    expect((await complete.execute(merchantId, setupIntentId)).status).toBe('active')
    const readsAfterComplete = stripe.reads
    const id = eventId()
    await useCase.receive(stripeEvent(id, 'setup_intent.succeeded', { id: setupIntentId, metadata: { merchant_id: merchantId } }))
    await useCase.processBatch()
    expect(stripe.reads).toBe(readsAfterComplete)
    expect((await webhookState(id)).rows[0]?.status).toBe('processed')
    expect(await activeSetupIntents(merchantId)).toEqual([setupIntentId])
  })

  it('starts no payments worker from buildApp() while Stripe is disabled', async () => {
    const app = await buildApp()
    try {
      const id = await webhook()
      await new Promise<void>((resolve) => { setTimeout(resolve, 3_000) })
      expect((await webhookState(id)).rows[0]).toMatchObject({ status: 'pending', attempts: 0 })
    } finally {
      await app.close()
    }
  }, 30_000)

  it('runs the payments worker cycle against the real repository until it is stopped', async () => {
    const { merchantId, setupIntentId, stripe } = await pendingSucceededSetup()
    const useCase = new HandleStripeWebhookUseCase(repository, new CompleteSepaSetupIntentUseCase(repository, stripe))
    const reconcile = new ReconcileDetachmentsUseCase(repository, stripe)
    const id = eventId()
    await useCase.receive(stripeEvent(id, 'setup_intent.succeeded', { id: setupIntentId, metadata: { merchant_id: merchantId } }))
    const stop = startStripePaymentsWorker({ processWebhooks: () => useCase.processBatch(), reconcileDetachments: () => reconcile.run() }, undefined, 50)
    try {
      await vi.waitFor(async () => { expect((await webhookState(id)).rows[0]?.status).toBe('processed') }, { timeout: 5_000, interval: 50 })
    } finally {
      stop()
    }
    expect(await activeSetupIntents(merchantId)).toEqual([setupIntentId])
    await new Promise<void>((resolve) => { setTimeout(resolve, 150) })
    const afterStop = await webhook()
    await new Promise<void>((resolve) => { setTimeout(resolve, 400) })
    expect((await webhookState(afterStop)).rows[0]).toMatchObject({ status: 'pending', attempts: 0 })
  })
})
