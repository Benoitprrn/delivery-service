import { describe, expect, it } from 'vitest'
import { assertCashOnDeliveryPaymentTransition, canTransitionCashOnDeliveryPayment } from '../../src/modules/cash-on-delivery/domain/cash-on-delivery-payment-state-machine.js'
import { assertCompletionSessionTransition, canTransitionCompletionSession } from '../../src/modules/cash-on-delivery/domain/completion-session-state-machine.js'

describe('machines COD', () => {
  it('accepte chemin session et refuse saut', () => {
    expect(canTransitionCompletionSession('open', 'code_verified')).toBe(true)
    expect(canTransitionCompletionSession('payment_succeeded', 'completed')).toBe(true)
    expect(() => assertCompletionSessionTransition('open', 'completed')).toThrow()
    expect(() => assertCompletionSessionTransition('completed', 'open')).toThrow()
  })

  it('accepte chemin paiement et récupération unknown', () => {
    expect(canTransitionCashOnDeliveryPayment('created', 'intent_created')).toBe(true)
    expect(canTransitionCashOnDeliveryPayment('authorized', 'captured')).toBe(true)
    expect(canTransitionCashOnDeliveryPayment('unknown', 'captured')).toBe(true)
    expect(() => assertCashOnDeliveryPaymentTransition('captured', 'authorized')).toThrow()
    expect(() => assertCashOnDeliveryPaymentTransition('created', 'captured')).toThrow()
  })
})
