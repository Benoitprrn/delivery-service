import Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import {
  assertDistinctApprover, classifyReversalError, decideReversalExecution, fundsBucket, InvalidReversalReasonError, ReversalAmountExceededError, ReversalApproverError, ReversalDecisionIncompleteError, ReversalLedgerMismatchError, ReversalRejectedError,
  ReversalTransientError, RestaurantDefaultReversalForbiddenError, validateReversalRequest
} from '../../../src/modules/settlements/public.js'

const NOW = new Date('2026-09-15T12:00:00Z')
const base = { requestedCents: 10_000, transfer: { amountCents: 10_000, ledgerReversedCents: 0, stripeAmountReversedCents: 0, chargeAvailableOn: new Date('2026-09-28T00:00:00Z') }, driverBalance: { availableCents: 0, pendingCents: 10_000 }, now: NOW }

describe('validateReversalRequest', () => {
  const valid = { category: 'driver_fault', reasonCode: 'order_stolen', reason: 'Colis volé', decisionReference: 'DEC-1', amountCents: 500, orderId: 'order-1' }
  it('accepts categories B and C with a coherent enumerated reason', () => {
    expect(validateReversalRequest(valid)).toMatchObject({ category: 'driver_fault', reasonCode: 'order_stolen', orderId: 'order-1' })
    expect(validateReversalRequest({ category: 'locadely_error', reasonCode: 'duplicate_transfer', reason: 'Doublon', decisionReference: 'DEC-2', amountCents: 500 })).toMatchObject({ category: 'locadely_error', orderId: null })
  })
  it('never accepts a restaurant failure, dispute or non payment, as category or as reason', () => {
    for (const category of ['restaurant_default', 'restaurant_dispute', 'sepa_return', 'unpaid_restaurant', 'dispute']) expect(() => validateReversalRequest({ ...valid, category })).toThrow(RestaurantDefaultReversalForbiddenError)
    for (const reasonCode of ['restaurant_default', 'sepa_failure', 'merchant_dispute', 'impayé_restaurant', 'litige']) expect(() => validateReversalRequest({ ...valid, reasonCode })).toThrow(RestaurantDefaultReversalForbiddenError)
  })
  it('refuses a reason of the other category, an unknown reason, a missing order, a blank reason/reference and a non positive or non integer amount', () => {
    expect(() => validateReversalRequest({ ...valid, reasonCode: 'wrong_amount' })).toThrow(InvalidReversalReasonError)
    expect(() => validateReversalRequest({ ...valid, reasonCode: 'made_up' })).toThrow(InvalidReversalReasonError)
    expect(() => validateReversalRequest({ ...valid, orderId: null })).toThrow(InvalidReversalReasonError)
    for (const patch of [{ reason: ' ' }, { decisionReference: '' }, { amountCents: 0 }, { amountCents: -1 }, { amountCents: 1.5 }]) expect(() => validateReversalRequest({ ...valid, ...patch })).toThrow(ReversalDecisionIncompleteError)
  })
  it('a requester can never approve his own reversal', () => {
    expect(() => assertDistinctApprover('u1', 'u1')).toThrow(ReversalApproverError)
    expect(() => assertDistinctApprover('u1', 'u2')).not.toThrow()
  })
})

describe('decideReversalExecution (decided BEFORE any Stripe call)', () => {
  it('example 1 — funds still pending and enough balance: the full amount is reversed, nothing left as receivable', () => {
    expect(decideReversalExecution(base)).toEqual({ reverseNowCents: 10_000, receivableCents: 0, recoverableCents: 10_000, bucket: 'pending' })
  })
  it('example 2 — funds already available and paid out (balance 0): nothing reversed at Stripe, everything becomes a receivable, never a negative balance', () => {
    const plan = decideReversalExecution({ ...base, transfer: { ...base.transfer, chargeAvailableOn: new Date('2026-09-10T00:00:00Z') }, driverBalance: { availableCents: 0, pendingCents: 0 } })
    expect(plan).toEqual({ reverseNowCents: 0, receivableCents: 10_000, recoverableCents: 0, bucket: 'available' })
  })
  it('example 3 — partial: by decision (less than the transfer) and by insufficient balance (recoverable part reversed, rest receivable)', () => {
    expect(decideReversalExecution({ ...base, requestedCents: 4_000 })).toMatchObject({ reverseNowCents: 4_000, receivableCents: 0 })
    expect(decideReversalExecution({ ...base, transfer: { ...base.transfer, chargeAvailableOn: new Date('2026-09-10T00:00:00Z') }, driverBalance: { availableCents: 3_000, pendingCents: 50_000 } }))
      .toMatchObject({ reverseNowCents: 3_000, receivableCents: 7_000, bucket: 'available' }) // seul le bon compartiment compte : les fonds pending d'autres Transfers ne sont pas touchés
  })
  it('a negative Stripe balance recovers nothing; an already reversed part reduces what is left', () => {
    expect(decideReversalExecution({ ...base, driverBalance: { availableCents: -500, pendingCents: -20 } })).toMatchObject({ reverseNowCents: 0, receivableCents: 10_000 })
    const second = { ...base, requestedCents: 6_000, transfer: { ...base.transfer, ledgerReversedCents: 4_000, stripeAmountReversedCents: 4_000 } }
    expect(decideReversalExecution(second)).toMatchObject({ reverseNowCents: 6_000, receivableCents: 0 })
    expect(() => decideReversalExecution({ ...second, requestedCents: 6_001 })).toThrow(ReversalAmountExceededError)
  })
  it('refuses to decide when Stripe and the ledger disagree on what is already reversed', () => {
    expect(() => decideReversalExecution({ ...base, transfer: { ...base.transfer, ledgerReversedCents: 0, stripeAmountReversedCents: 100 } })).toThrow(ReversalLedgerMismatchError)
  })
  it('only an explicit decision can accept a negative balance (never used in R61)', () => {
    const shortBalance = { ...base, driverBalance: { availableCents: 0, pendingCents: 2_000 } }
    expect(decideReversalExecution(shortBalance)).toMatchObject({ reverseNowCents: 2_000, receivableCents: 8_000 })
    expect(decideReversalExecution({ ...shortBalance, allowNegativeBalance: true })).toMatchObject({ reverseNowCents: 10_000, receivableCents: 0 })
  })
  it('an unknown availability date is treated as pending (conservative)', () => {
    expect(fundsBucket(null, NOW)).toBe('pending')
    expect(fundsBucket(NOW, NOW)).toBe('available')
  })
})

describe('Stripe reversal error classification', () => {
  it('an over-reversal or invalid request is a definitive refusal; platform/transport errors leave the result unknown', () => {
    expect(classifyReversalError(new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message: 'only has (€20.00) remaining to reverse' } as never))).toBeInstanceOf(ReversalRejectedError)
    expect(classifyReversalError(new Stripe.errors.StripeIdempotencyError({ type: 'idempotency_error', message: 'x' } as never))).toMatchObject({ code: 'idempotency_mismatch' })
    for (const error of [new Stripe.errors.StripeAPIError({ type: 'api_error', message: 'x' } as never), new Stripe.errors.StripeAuthenticationError({ type: 'authentication_error', message: 'x' } as never), new Error('boom')]) {
      expect(classifyReversalError(error)).toBeInstanceOf(ReversalTransientError)
    }
  })
})
