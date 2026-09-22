import { describe, expect, it } from 'vitest'
import { reduceStripeEvent, SETTLEMENT_WEBHOOK_EVENT_TYPES, triageSettlementEvent } from '../../../src/modules/settlements/public.js'

describe('Stripe event triage', () => {
  it('exposes exactly the settlement event types', () => expect(SETTLEMENT_WEBHOOK_EVENT_TYPES).toEqual(['payment_intent.processing', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'payment_intent.requires_action', 'charge.pending', 'charge.succeeded', 'charge.failed', 'charge.updated', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'transfer.created', 'transfer.updated', 'transfer.reversed']))
  it('reduces intent, charge, dispute and transfer identifiers without trusting malformed values', () => {
    expect(reduceStripeEvent({ id: 'evt', type: 'payment_intent.succeeded', data: { object: { id: 'pi', latest_charge: { id: 'ch' } } } })).toMatchObject({ objectId: 'pi', paymentIntentId: 'pi', chargeId: 'ch', accountId: null })
    expect(reduceStripeEvent({ id: 'evt', type: 'charge.succeeded', account: 'acct', data: { object: { id: 'ch', payment_intent: 'pi' } } })).toMatchObject({ objectId: 'ch', chargeId: 'ch', paymentIntentId: 'pi', accountId: 'acct' })
    expect(reduceStripeEvent({ id: 'evt', type: 'charge.dispute.created', data: { object: { id: 'dp', charge: { id: 'ch' }, payment_intent: { id: 'pi' } } } })).toMatchObject({ objectId: 'dp', chargeId: 'ch', paymentIntentId: 'pi' })
    expect(reduceStripeEvent({ id: 'evt', type: 'transfer.updated', data: { object: { id: 'tr' } } })).toMatchObject({ objectId: 'tr', transferId: 'tr' })
    expect(reduceStripeEvent({ id: 'evt', type: 'charge.failed', data: { object: { id: 1, payment_intent: {} } } })).toMatchObject({ objectId: null, chargeId: null, paymentIntentId: null })
  })
  it('keeps Connect events out and maps each supported action', () => {
    expect(triageSettlementEvent({ id: 'e', type: 'payment_intent.succeeded', accountId: 'acct', objectId: null, paymentIntentId: 'pi', chargeId: null, transferId: null })).toEqual({ action: 'ignore', reason: 'connect_event' })
    expect(triageSettlementEvent({ id: 'e', type: 'charge.refunded', accountId: null, objectId: null, paymentIntentId: null, chargeId: 'ch', transferId: null })).toEqual({ action: 'refresh_incident', chargeId: 'ch' })
    expect(triageSettlementEvent({ id: 'e', type: 'transfer.reversed', accountId: null, objectId: null, paymentIntentId: null, chargeId: null, transferId: 'tr' })).toEqual({ action: 'audit_transfer', transferId: 'tr' })
    expect(triageSettlementEvent({ id: 'e', type: 'charge.succeeded', accountId: null, objectId: null, paymentIntentId: null, chargeId: 'ch', transferId: null })).toEqual({ action: 'refresh_debit', paymentIntentId: null, chargeId: 'ch' })
  })
  it('rejects unsupported and identifier-less events', () => {
    expect(triageSettlementEvent({ id: 'e', type: 'customer.created', accountId: null, objectId: null, paymentIntentId: null, chargeId: null, transferId: null })).toEqual({ action: 'ignore', reason: 'unsupported_type' })
    expect(triageSettlementEvent({ id: 'e', type: 'charge.dispute.closed', accountId: null, objectId: null, paymentIntentId: null, chargeId: null, transferId: null })).toEqual({ action: 'ignore', reason: 'missing_identifier' })
  })
})
