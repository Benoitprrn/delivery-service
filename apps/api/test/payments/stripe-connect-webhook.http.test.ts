import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import rawBody from 'fastify-raw-body'
import Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerCorrelationId } from '../../src/platform/correlation-id.js'
import { registerAuthentication } from '../../src/modules/auth/transport/http/authentication-hook.js'
import { ReceiveConnectWebhookUseCase } from '../../src/modules/payments/application/connect-webhook.js'
import { StripeConnectWebhookVerifier, UnavailableConnectWebhookVerifier } from '../../src/modules/payments/infrastructure/stripe-connect-webhook-verifier.js'
import { registerStripeConnectWebhookRoute } from '../../src/modules/payments/transport/http/connect-webhook-routes.js'
import type {
  ClaimedConnectWebhookEvent,
  ConnectWebhookFailure,
  ConnectWebhookRepository,
  ConnectWebhookVerifier,
  StoredConnectWebhookEvent
} from '../../src/modules/payments/ports/connect-webhook.js'
import { CONNECT_SECRET, THIN_SECRET, paymentIntentEvent, sign, snapshotEvent, thinEvent } from '../support/stripe-connect-webhook.js'

const PATH = '/api/v1/webhooks/stripe-connect'
const headers = (signature?: string) => ({
  'content-type': 'application/json',
  ...(signature === undefined ? {} : { 'stripe-signature': signature })
})

class RecordingRepository implements ConnectWebhookRepository {
  readonly recorded: StoredConnectWebhookEvent[] = []
  failNext = false

  async record(event: StoredConnectWebhookEvent): Promise<void> {
    if (this.failNext) throw new Error('database down: secret detail')
    this.recorded.push(event)
  }
  async claimNext(): Promise<ClaimedConnectWebhookEvent | null> { return null }
  async complete(): Promise<boolean> { return true }
  async fail(_failure: ConnectWebhookFailure): Promise<boolean> { return true }
  async findMerchantIdByAccountId(): Promise<string | null> { return null }
}

async function build(verifier: ConnectWebhookVerifier, repository: RecordingRepository): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  registerCorrelationId(app)
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' })
  // Verifier JWT qui refuse tout : la route Connect doit rester publique sur son chemin exact.
  registerAuthentication(app, { verifier: { verify: async () => { throw new Error('no jwt accepted') } } })
  await app.register(rawBody, { field: 'rawBody', global: false, encoding: 'utf8', runFirst: true })
  const receive = new ReceiveConnectWebhookUseCase(verifier, repository)
  await app.register(registerStripeConnectWebhookRoute, { webhooks: { receiveWebhook: receive.receive.bind(receive) } })
  app.get('/limited', { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } }, async () => ({ ok: true }))
  return app
}

describe('POST /api/v1/webhooks/stripe-connect', () => {
  let app: FastifyInstance
  let repository: RecordingRepository

  beforeEach(async () => {
    repository = new RecordingRepository()
    // Aucun appel réseau : le client Stripe ne sert qu'à vérifier/parsers localement.
    const verifier = new StripeConnectWebhookVerifier(new Stripe('sk_test_local_only', { maxNetworkRetries: 0 }), [CONNECT_SECRET, THIN_SECRET])
    app = await build(verifier, repository)
  })
  afterEach(async () => { await app.close() })

  describe('signature verification (always on, on the raw body)', () => {
    const payload = paymentIntentEvent('evt_1', 'payment_intent.succeeded', 'pi_1')

    it('answers 400 without a Stripe-Signature header, and persists nothing', async () => {
      const response = await app.inject({ method: 'POST', url: PATH, payload, headers: headers() })
      expect(response.statusCode).toBe(400)
      expect(repository.recorded).toEqual([])
    })

    it('answers 400 for a malformed or forged signature', async () => {
      for (const signature of ['v1=invalid', 't=1,v1=deadbeef', sign(payload, 'whsec_someone_else')]) {
        const response = await app.inject({ method: 'POST', url: PATH, payload, headers: headers(signature) })
        expect(response.statusCode).toBe(400)
        expect(response.json()).toEqual({ error: 'InvalidStripeWebhook' })
      }
      expect(repository.recorded).toEqual([])
    })

    it('answers 400 when the body differs from the signed raw body by a single byte', async () => {
      const signature = sign(payload)
      const tampered = payload.replace('"pi_1"', '"pi_2"')
      const response = await app.inject({ method: 'POST', url: PATH, payload: tampered, headers: headers(signature) })
      expect(response.statusCode).toBe(400)
      expect(repository.recorded).toEqual([])
    })

    it('answers 400 for a replayed signature outside the timestamp tolerance', async () => {
      const stale = sign(payload, CONNECT_SECRET, Math.floor(Date.now() / 1000) - 3_600)
      const response = await app.inject({ method: 'POST', url: PATH, payload, headers: headers(stale) })
      expect(response.statusCode).toBe(400)
      expect(repository.recorded).toEqual([])
    })

    it('accepts a valid signature and answers 200', async () => {
      const response = await app.inject({ method: 'POST', url: PATH, payload, headers: headers(sign(payload)) })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ received: true })
      expect(repository.recorded).toHaveLength(1)
    })
  })

  describe('persistence: identifiers only, never the payload', () => {
    it.each([
      'payment_intent.succeeded',
      'payment_intent.payment_failed',
      'payment_intent.canceled',
      'payment_intent.amount_capturable_updated'
    ])('records %s with the connected account and the PaymentIntent id', async (type) => {
      const payload = paymentIntentEvent('evt_pi', type, 'pi_abc', 'acct_restaurant_a')
      const response = await app.inject({ method: 'POST', url: PATH, payload, headers: headers(sign(payload)) })
      expect(response.statusCode).toBe(200)
      expect(repository.recorded).toEqual([{
        eventId: 'evt_pi',
        eventType: type,
        accountId: 'acct_restaurant_a',
        objectId: 'pi_abc',
        paymentIntentId: 'pi_abc',
        merchantId: null,
        orderId: null
      }])
    })

    it('stores merchant_id and order_id from metadata only when they are UUIDs', async () => {
      const merchantId = '22222222-2222-4222-8222-222222222222'
      const good = paymentIntentEvent('evt_uuid', 'payment_intent.succeeded', 'pi_1', 'acct_restaurant_a', { merchant_id: merchantId, order_id: '33333333-3333-4333-8333-333333333333', payment_id: 'p' })
      const bad = paymentIntentEvent('evt_bad', 'payment_intent.succeeded', 'pi_2', 'acct_restaurant_a', { merchant_id: "x'; drop table merchants;--", order_id: 'not-a-uuid' })
      await app.inject({ method: 'POST', url: PATH, payload: good, headers: headers(sign(good)) })
      await app.inject({ method: 'POST', url: PATH, payload: bad, headers: headers(sign(bad)) })
      expect(repository.recorded[0]).toMatchObject({ merchantId, orderId: '33333333-3333-4333-8333-333333333333' })
      expect(repository.recorded[1]).toMatchObject({ merchantId: null, orderId: null })
    })

    it('records charge.refunded and charge.dispute.created with their PaymentIntent id, not the payload', async () => {
      const refund = snapshotEvent({ id: 'evt_refund', type: 'charge.refunded', object: { id: 'ch_1', object: 'charge', payment_intent: 'pi_1', amount_refunded: 5000, billing_details: { name: 'Jean Client' } } })
      const dispute = snapshotEvent({ id: 'evt_dispute', type: 'charge.dispute.created', object: { id: 'dp_1', object: 'dispute', payment_intent: 'pi_1', charge: 'ch_1', amount: 5000 } })
      for (const payload of [refund, dispute]) {
        expect((await app.inject({ method: 'POST', url: PATH, payload, headers: headers(sign(payload)) })).statusCode).toBe(200)
      }
      expect(repository.recorded).toEqual([
        { eventId: 'evt_refund', eventType: 'charge.refunded', accountId: 'acct_restaurant_a', objectId: 'ch_1', paymentIntentId: 'pi_1', merchantId: null, orderId: null },
        { eventId: 'evt_dispute', eventType: 'charge.dispute.created', accountId: 'acct_restaurant_a', objectId: 'dp_1', paymentIntentId: 'pi_1', merchantId: null, orderId: null }
      ])
      expect(JSON.stringify(repository.recorded)).not.toContain('Jean Client')
    })

    it.each([
      'v2.core.account[configuration.merchant].capability_status_updated',
      'v2.core.account[configuration.merchant].updated',
      'v2.core.account[requirements].updated',
      'v2.core.account.closed',
      // R30 : destination « Votre compte / Léger » créée pour les comptes de paiement des livreurs (même endpoint, secret propre)
      'v2.core.account[configuration.recipient].capability_status_updated',
      'v2.core.account[configuration.recipient].updated'
    ])('records the thin v2 event %s with the account of its related object', async (type) => {
      const payload = thinEvent('evt_thin', type, 'acct_restaurant_a')
      const response = await app.inject({ method: 'POST', url: PATH, payload, headers: headers(sign(payload, THIN_SECRET)) })
      expect(response.statusCode).toBe(200)
      expect(repository.recorded).toEqual([{ eventId: 'evt_thin', eventType: type, accountId: 'acct_restaurant_a', objectId: 'acct_restaurant_a', paymentIntentId: null, merchantId: null, orderId: null }])
    })

    it('acknowledges (2xx) without persisting any other signed event type', async () => {
      const unsupported = [
        snapshotEvent({ id: 'evt_u1', type: 'setup_intent.succeeded', object: { id: 'seti_1' } }),
        snapshotEvent({ id: 'evt_u2', type: 'charge.succeeded', object: { id: 'ch_1' } }),
        snapshotEvent({ id: 'evt_u3', type: 'charge.dispute.closed', object: { id: 'dp_1' } }),
        thinEvent('evt_u4', 'v2.core.account_person.updated', 'acct_restaurant_a'),
        thinEvent('evt_u5', 'v2.core.account[configuration.customer].updated', 'acct_restaurant_a')
      ]
      for (const payload of unsupported) {
        const response = await app.inject({ method: 'POST', url: PATH, payload, headers: headers(sign(payload, THIN_SECRET)) })
        expect(response.statusCode).toBe(200)
      }
      expect(repository.recorded).toEqual([])
    })

    it('acknowledges without persisting a snapshot that carries no connected account (nothing to authorize)', async () => {
      const withoutAccount = snapshotEvent({ id: 'evt_no_account', type: 'payment_intent.succeeded', account: null, object: { id: 'pi_1' } })
      expect((await app.inject({ method: 'POST', url: PATH, payload: withoutAccount, headers: headers(sign(withoutAccount)) })).statusCode).toBe(200)
      const badAccount = snapshotEvent({ id: 'evt_bad_account', type: 'payment_intent.succeeded', account: 'not-an-account', object: { id: 'pi_1' } })
      expect((await app.inject({ method: 'POST', url: PATH, payload: badAccount, headers: headers(sign(badAccount)) })).statusCode).toBe(200)
      expect(repository.recorded).toEqual([])
    })
  })

  describe('one secret per Stripe event destination', () => {
    it('accepts either configured secret, and only those', async () => {
      const snapshot = paymentIntentEvent('evt_a', 'payment_intent.succeeded', 'pi_1')
      const thin = thinEvent('evt_b', 'v2.core.account[requirements].updated', 'acct_restaurant_a')
      expect((await app.inject({ method: 'POST', url: PATH, payload: snapshot, headers: headers(sign(snapshot, CONNECT_SECRET)) })).statusCode).toBe(200)
      expect((await app.inject({ method: 'POST', url: PATH, payload: thin, headers: headers(sign(thin, THIN_SECRET)) })).statusCode).toBe(200)
      expect((await app.inject({ method: 'POST', url: PATH, payload: thin, headers: headers(sign(thin, 'whsec_unknown')) })).statusCode).toBe(400)
      expect(repository.recorded.map((event) => event.eventId)).toEqual(['evt_a', 'evt_b'])
    })
  })

  describe('failure conventions', () => {
    it('answers 500 (so Stripe redelivers) when the durable receipt fails, without leaking details', async () => {
      repository.failNext = true
      const payload = paymentIntentEvent('evt_500', 'payment_intent.succeeded', 'pi_1')
      const response = await app.inject({ method: 'POST', url: PATH, payload, headers: headers(sign(payload)) })
      expect(response.statusCode).toBe(500)
      expect(response.json()).toEqual({ error: 'StripeWebhookReceiptError', correlationId: expect.any(String) })
      expect(response.body).not.toContain('secret detail')
    })

    it('answers 503, never 400, when the Connect webhook is not configured', async () => {
      const unavailable = await build(new UnavailableConnectWebhookVerifier(), repository)
      const payload = paymentIntentEvent('evt_503', 'payment_intent.succeeded', 'pi_1')
      const response = await unavailable.inject({ method: 'POST', url: PATH, payload, headers: headers(sign(payload)) })
      expect(response.statusCode).toBe(503)
      expect(response.json()).toEqual({ error: 'StripeUnavailable', correlationId: expect.any(String) })
      expect(repository.recorded).toEqual([])
      await unavailable.close()
    })
  })

  describe('exposure', () => {
    it('is public only on its exact path and POST method', async () => {
      const payload = paymentIntentEvent('evt_public', 'payment_intent.succeeded', 'pi_1')
      expect((await app.inject({ method: 'POST', url: PATH, payload, headers: headers(sign(payload)) })).statusCode).toBe(200)
      expect((await app.inject({ method: 'GET', url: PATH })).statusCode).toBe(401)
      expect((await app.inject({ method: 'POST', url: `${PATH}/other`, payload, headers: headers(sign(payload)) })).statusCode).toBe(401)
      expect((await app.inject({ method: 'POST', url: '/api/v1/webhooks/stripe-connectx', payload, headers: headers(sign(payload)) })).statusCode).toBe(401)
      expect((await app.inject({ method: 'POST', url: '/api/v1/webhooks', payload, headers: headers(sign(payload)) })).statusCode).toBe(401)
    })

    it('is exempt from the global rate limit while ordinary routes remain limited', async () => {
      const payload = paymentIntentEvent('evt_rate', 'payment_intent.succeeded', 'pi_1')
      const overGlobalLimit = 110 // plafond global : 100/min
      const replies = await Promise.all(Array.from({ length: overGlobalLimit }, () => app.inject({ method: 'POST', url: PATH, payload, headers: headers(sign(payload)) })))
      expect(replies.every((reply) => reply.statusCode === 200)).toBe(true)
      await app.inject({ method: 'GET', url: '/limited' })
      await app.inject({ method: 'GET', url: '/limited' })
      expect((await app.inject({ method: 'GET', url: '/limited' })).statusCode).toBe(429)
    })
  })
})
