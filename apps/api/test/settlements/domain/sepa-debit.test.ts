import { describe, expect, it } from 'vitest'
import Stripe from 'stripe'
import { buildDebitIdempotencyKey, checkNotifiedMandate, classifyDebitObservation, classifyReadError, classifyStripeError, isDebitDue, parseLocalDate, SepaDebitRejectedError, SepaDebitTechnicalError, SepaDebitTransientError, toObservation, type DebitObservation } from '../../../src/modules/settlements/public.js'

const observation = (over: Partial<DebitObservation> = {}): DebitObservation => ({ paymentIntentId: 'pi_1', paymentIntentStatus: 'processing', amountCents: 1384, currency: 'eur', livemode: false, attemptIdMetadata: 'a1', chargeId: 'ch_1', chargeStatus: 'pending', paid: false, hasBalanceTransaction: false, availableOn: null, failureCode: null, ...over })

describe('SEPA debit domain', () => {
  it('builds a stable idempotency key per settlement and attempt and refuses ambiguous input', () => {
    expect(buildDebitIdempotencyKey({ merchantSettlementId: 'abc', attemptNo: 1 })).toBe('debit:abc:attempt:1')
    expect(() => buildDebitIdempotencyKey({ merchantSettlementId: 'a:b', attemptNo: 1 })).toThrow()
    expect(() => buildDebitIdempotencyKey({ merchantSettlementId: 'abc', attemptNo: 0 })).toThrow()
  })

  it.each([
    ['day before', '2026-09-01T21:59:59Z', false],
    ['07:59:59 Paris on the announced day', '2026-09-02T05:59:59Z', false],
    ['08:00:00 Paris on the announced day (CEST)', '2026-09-02T06:00:00Z', true],
    ['winter time: 08:00 CET = 07:00Z', '2026-12-02T07:00:00Z', true],
    ['winter time: 06:59Z is 07:59 CET', '2026-12-02T06:59:59Z', false],
  ])('debit due %s', (_label, now, expected) => {
    const debitDate = parseLocalDate(now.startsWith('2026-12') ? '2026-12-02' : '2026-09-02')
    expect(isDebitDue(debitDate, new Date(now))).toBe(expected)
  })

  it('accepts only the mandate quoted in the pre-notification', () => {
    expect(checkNotifiedMandate({ notifiedMandateReference: 'M1', activeMandateReference: 'M1' })).toEqual({ ok: true })
    expect(checkNotifiedMandate({ notifiedMandateReference: 'M1', activeMandateReference: 'M2' })).toEqual({ ok: false, reason: 'mandate_changed' })
    expect(checkNotifiedMandate({ notifiedMandateReference: 'M1', activeMandateReference: null })).toEqual({ ok: false, reason: 'no_active_sepa_method' })
  })

  it('classifies succeeded only with PI + charge succeeded, paid and a balance transaction', () => {
    expect(classifyDebitObservation(observation())).toEqual({ state: 'processing', failureCode: null })
    expect(classifyDebitObservation(observation({ paymentIntentStatus: 'succeeded', chargeStatus: 'succeeded', paid: true, hasBalanceTransaction: true }))).toEqual({ state: 'succeeded', failureCode: null })
    for (const partial of [{ chargeStatus: 'pending' }, { paid: false }, { hasBalanceTransaction: false }]) {
      expect(classifyDebitObservation(observation({ paymentIntentStatus: 'succeeded', chargeStatus: 'succeeded', paid: true, hasBalanceTransaction: true, ...partial })).state).toBe('processing')
    }
  })

  it('classifies a REAL bank rejection as failed and keeps the Stripe failure code', () => {
    expect(classifyDebitObservation(observation({ paymentIntentStatus: 'requires_payment_method', chargeStatus: 'failed', failureCode: 'account_closed' }))).toEqual({ state: 'failed', failureCode: 'account_closed' })
    expect(classifyDebitObservation(observation({ paymentIntentStatus: 'requires_payment_method', chargeStatus: 'failed' }))).toEqual({ state: 'failed', failureCode: 'payment_failed' })
    expect(classifyDebitObservation(observation({ paymentIntentStatus: 'requires_payment_method', chargeStatus: null, failureCode: 'card_declined' })).state).toBe('failed')
  })

  it('never qualifies the restaurant as unpaid when nothing proves a rejection: canceled, unexpected status, no payment error are TECHNICAL', () => {
    expect(classifyDebitObservation(observation({ paymentIntentStatus: 'canceled', chargeStatus: null }))).toEqual({ state: 'technical', failureCode: 'technical:payment_intent_canceled' })
    expect(classifyDebitObservation(observation({ paymentIntentStatus: 'requires_payment_method', chargeStatus: null, failureCode: null }))).toEqual({ state: 'technical', failureCode: 'technical:requires_payment_method_without_error' })
    expect(classifyDebitObservation(observation({ paymentIntentStatus: 'requires_action', chargeStatus: null }))).toEqual({ state: 'technical', failureCode: 'technical:unexpected_status:requires_action' })
    expect(classifyDebitObservation(observation({ chargeStatus: 'canceled' })).state).toBe('technical')
  })
})

describe('Stripe error classification', () => {
  const card = new Stripe.errors.StripeCardError({ type: 'card_error', code: 'card_declined', message: 'x' } as never)
  const invalid = new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', code: 'resource_missing', message: 'x' } as never)
  const api = new Stripe.errors.StripeAPIError({ type: 'api_error', message: 'x' } as never)
  const auth = new Stripe.errors.StripeAuthenticationError({ type: 'authentication_error', message: 'x' } as never)
  const rate = new Stripe.errors.StripeRateLimitError({ type: 'rate_limit_error', message: 'x' } as never)

  it('rejects the DEBTOR only on a card/bank error', () => {
    expect(classifyStripeError(card)).toBeInstanceOf(SepaDebitRejectedError)
    expect(classifyStripeError(card)).toMatchObject({ code: 'card_declined' })
  })
  it('treats a bad request, a bad configuration or a hijacked idempotency key as a TECHNICAL error, never as a restaurant rejection', () => {
    expect(classifyStripeError(invalid)).toBeInstanceOf(SepaDebitTechnicalError)
    expect(classifyStripeError(invalid)).toMatchObject({ code: 'invalid_request:resource_missing' })
    expect(classifyStripeError(new Stripe.errors.StripeIdempotencyError({ type: 'idempotency_error', message: 'x' } as never))).toMatchObject({ code: 'idempotency_mismatch' })
    expect(classifyStripeError(invalid)).not.toBeInstanceOf(SepaDebitRejectedError)
  })
  it('never fails a restaurant on a platform or transport problem: authentication, 5xx, rate limit, network are transient', () => {
    for (const error of [api, auth, rate, new Error('socket hang up')]) expect(classifyStripeError(error)).toBeInstanceOf(SepaDebitTransientError)
  })
  it('never turns a failed READ into a failed debit', () => {
    for (const error of [card, invalid, api]) expect(classifyReadError(error)).toBeInstanceOf(SepaDebitTransientError)
  })
})

describe('toObservation', () => {
  it('maps an expanded PaymentIntent with its charge and balance transaction', () => {
    const intent = { id: 'pi_1', status: 'succeeded', amount: 401, currency: 'eur', livemode: false, metadata: { debit_attempt_id: 'a1' }, last_payment_error: null,
      latest_charge: { id: 'ch_1', status: 'succeeded', paid: true, failure_code: null, balance_transaction: { id: 'txn_1', available_on: 1_788_000_000 } } } as unknown as Stripe.PaymentIntent
    expect(toObservation(intent)).toMatchObject({ paymentIntentId: 'pi_1', amountCents: 401, chargeId: 'ch_1', chargeStatus: 'succeeded', paid: true, hasBalanceTransaction: true, attemptIdMetadata: 'a1' })
    expect(toObservation(intent).availableOn?.toISOString()).toBe(new Date(1_788_000_000 * 1000).toISOString())
  })
  it('handles a processing PaymentIntent whose charge is only an id', () => {
    const intent = { id: 'pi_2', status: 'processing', amount: 5, currency: 'eur', livemode: false, metadata: {}, last_payment_error: null, latest_charge: 'ch_2' } as unknown as Stripe.PaymentIntent
    expect(toObservation(intent)).toMatchObject({ chargeId: 'ch_2', chargeStatus: null, paid: false, hasBalanceTransaction: false, availableOn: null })
  })
})
