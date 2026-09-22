import { describe, expect, it } from 'vitest'
import { classifyCharge } from '../../../src/modules/settlements/public.js'

const complete = { paymentIntentStatus: 'succeeded', chargeStatus: 'succeeded', paid: true, hasBalanceTransaction: true, amountCents: 100 }
describe('charge classification', () => {
  it('requires every success proof', () => {
    expect(classifyCharge(complete)).toBe('succeeded')
    expect(classifyCharge({ ...complete, paid: false })).not.toBe('succeeded')
    expect(classifyCharge({ ...complete, hasBalanceTransaction: false })).not.toBe('succeeded')
    expect(classifyCharge({ ...complete, chargeStatus: 'processing' })).not.toBe('succeeded')
  })
  it.each([{ ...complete, paymentIntentStatus: 'requires_payment_method' }, { ...complete, paymentIntentStatus: 'canceled', chargeStatus: 'pending', paid: false }, { ...complete, chargeStatus: 'failed' }, { ...complete, chargeStatus: 'canceled' }])('classifies definitive failures', (snapshot) => expect(classifyCharge(snapshot)).toBe('failed'))
})
