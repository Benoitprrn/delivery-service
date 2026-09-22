import { describe, expect, it } from 'vitest'
import {
  decideReconciliation,
  findPaymentIntentMismatches
} from '../../src/modules/cash-on-delivery/application/reconciliation-decision.js'
import type { CashOnDeliveryPayment } from '../../src/modules/cash-on-delivery/ports/cash-on-delivery-payment-repository.js'
import type { TerminalPaymentIntent } from '../../src/modules/cash-on-delivery/ports/connect-payments-provider.js'

function payment(overrides: Partial<CashOnDeliveryPayment> = {}): CashOnDeliveryPayment {
  return {
    id: 'pay_1', orderId: 'order_1', sessionId: 'sess_1', merchantId: 'm', driverId: 'd', attemptNo: 1,
    stripeAccountId: 'acct_1', amountCents: 5000, currency: 'eur', stripePaymentIntentId: 'pi_1', stripeChargeId: null,
    status: 'intent_created', captureIdempotencyKey: 'cap', createIdempotencyKey: 'cre', readerType: 'bluetooth',
    readerSerial: null, terminalLocationId: 'tml_1', failureCode: null, declineCode: null,
    ...overrides
  }
}

function intent(overrides: Partial<TerminalPaymentIntent> = {}): TerminalPaymentIntent {
  return {
    id: 'pi_1', accountId: 'acct_1', status: 'requires_payment_method', amountCents: 5000, amountCapturableCents: 0,
    amountReceivedCents: 0, currency: 'eur', clientSecret: null, metadata: { order_id: 'order_1', payment_id: 'pay_1' },
    captureMethod: 'manual', paymentMethodTypes: ['card_present'], applicationFeeAmountCents: null, hasTransferData: false,
    hasOnBehalfOf: false, chargeId: null, lastPaymentErrorCode: null, lastPaymentErrorDeclineCode: null,
    ...overrides
  }
}

const captured = { status: 'succeeded' as const, amountReceivedCents: 5000, chargeId: 'ch_1' }

describe('findPaymentIntentMismatches', () => {
  it('accepts a PaymentIntent that matches the local payment exactly', () => {
    expect(findPaymentIntentMismatches(intent(), payment())).toEqual([])
  })

  it.each<[string, Partial<TerminalPaymentIntent>]>([
    ['id', { id: 'pi_other' }],
    ['account', { accountId: 'acct_other' }],
    ['amount', { amountCents: 4999 }],
    ['currency', { currency: 'usd' }],
    ['capture_method', { captureMethod: 'automatic' }],
    ['payment_method_types', { paymentMethodTypes: ['card'] }],
    ['payment_method_types', { paymentMethodTypes: ['card_present', 'card'] }],
    ['application_fee', { applicationFeeAmountCents: 1 }],
    ['transfer_data', { hasTransferData: true }],
    ['on_behalf_of', { hasOnBehalfOf: true }],
    ['metadata.order_id', { metadata: { order_id: 'order_other', payment_id: 'pay_1' } }],
    ['metadata.payment_id', { metadata: { order_id: 'order_1', payment_id: 'pay_other' } }],
    ['metadata.payment_id', { metadata: { order_id: 'order_1' } }]
  ])('reports %s', (field, override) => {
    expect(findPaymentIntentMismatches(intent(override), payment())).toContain(field)
  })
})

describe('decideReconciliation', () => {
  it('never completes a contaminated PaymentIntent, even when Stripe says succeeded', () => {
    const decision = decideReconciliation({ payment: payment(), intent: intent({ ...captured, accountId: 'acct_other' }), sessionAbandoned: true })
    expect(decision).toEqual({ kind: 'contaminated', mismatches: ['account'] })
  })

  it('treats a captured amount different from the local amount as contaminated', () => {
    const decision = decideReconciliation({ payment: payment(), intent: intent({ ...captured, amountReceivedCents: 4000 }), sessionAbandoned: false })
    expect(decision).toEqual({ kind: 'contaminated', mismatches: ['amount_received'] })
  })

  it('completes a captured PaymentIntent whatever the session state', () => {
    for (const sessionAbandoned of [true, false]) {
      expect(decideReconciliation({ payment: payment({ status: 'authorized' }), intent: intent(captured), sessionAbandoned })).toEqual({ kind: 'complete_captured' })
    }
  })

  it('flags a captured PaymentIntent behind a failed or canceled local payment for human review', () => {
    for (const status of ['failed', 'canceled'] as const) {
      expect(decideReconciliation({ payment: payment({ status }), intent: intent(captured), sessionAbandoned: true })).toEqual({ kind: 'captured_on_terminal_payment' })
    }
  })

  it('cancels an authorization only once the session is abandoned', () => {
    const authorized = intent({ status: 'requires_capture', amountCapturableCents: 5000 })
    expect(decideReconciliation({ payment: payment({ status: 'authorized' }), intent: authorized, sessionAbandoned: false })).toEqual({ kind: 'wait' })
    expect(decideReconciliation({ payment: payment({ status: 'authorized' }), intent: authorized, sessionAbandoned: true })).toEqual({ kind: 'cancel_intent', local: 'canceled' })
  })

  it('reflects a fresh authorization as authorized without cancelling it', () => {
    const authorized = intent({ status: 'requires_capture', amountCapturableCents: 5000 })
    for (const status of ['intent_created', 'processing', 'unknown'] as const) {
      expect(decideReconciliation({ payment: payment({ status }), intent: authorized, sessionAbandoned: false })).toEqual({ kind: 'mark_authorized' })
    }
  })

  it('cancels a stale unauthorized PaymentIntent and keeps the decline as failed', () => {
    expect(decideReconciliation({ payment: payment(), intent: intent(), sessionAbandoned: true })).toEqual({ kind: 'cancel_intent', local: 'canceled' })
    expect(decideReconciliation({ payment: payment(), intent: intent({ lastPaymentErrorCode: 'card_declined' }), sessionAbandoned: true })).toEqual({ kind: 'cancel_intent', local: 'failed' })
    expect(decideReconciliation({ payment: payment(), intent: intent(), sessionAbandoned: false })).toEqual({ kind: 'wait' })
  })

  it('cancels the PaymentIntent of an already failed/canceled payment without touching local state', () => {
    for (const status of ['failed', 'canceled'] as const) {
      expect(decideReconciliation({ payment: payment({ status }), intent: intent(), sessionAbandoned: false })).toEqual({ kind: 'cancel_intent', local: null })
      expect(decideReconciliation({ payment: payment({ status }), intent: intent({ status: 'requires_capture' }), sessionAbandoned: false })).toEqual({ kind: 'cancel_intent', local: null })
    }
  })

  it('mirrors a Stripe cancellation and waits on processing', () => {
    expect(decideReconciliation({ payment: payment(), intent: intent({ status: 'canceled' }), sessionAbandoned: false })).toEqual({ kind: 'mark_canceled' })
    expect(decideReconciliation({ payment: payment({ status: 'canceled' }), intent: intent({ status: 'canceled' }), sessionAbandoned: false })).toEqual({ kind: 'wait' })
    expect(decideReconciliation({ payment: payment(), intent: intent({ status: 'processing' }), sessionAbandoned: true })).toEqual({ kind: 'wait' })
  })
})
