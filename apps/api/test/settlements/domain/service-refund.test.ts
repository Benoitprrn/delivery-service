import { describe, expect, it } from 'vitest'
import { clampAttributedReversalCents, computeCumulativeServiceRefundCents, isServiceRefundEligible, RunServiceRefundsUseCase, type MerchantServiceRefundProvider, type ServiceRefundRepository } from '../../../src/modules/settlements/public.js'

describe('service refund allocation', () => {
  it('uses the cumulative integer formula without rounding drift', () => {
    expect(computeCumulativeServiceRefundCents({ deliveryCents: 1000, serviceFeeCents: 200, previouslyRecoveredCents: 0, reversedCents: 1000 })).toBe(200)
    const first = computeCumulativeServiceRefundCents({ deliveryCents: 1000, serviceFeeCents: 201, previouslyRecoveredCents: 0, reversedCents: 500 })
    const second = computeCumulativeServiceRefundCents({ deliveryCents: 1000, serviceFeeCents: 201, previouslyRecoveredCents: 500, reversedCents: 400 })
    expect([first, second]).toEqual([100, 80])
    expect(first + computeCumulativeServiceRefundCents({ deliveryCents: 1000, serviceFeeCents: 201, previouslyRecoveredCents: 500, reversedCents: 500 })).toBe(201)
  })
  it('only makes a specific positive driver fault eligible and clamps attribution to delivery', () => {
    expect(isServiceRefundEligible({ category: 'driver_fault', orderId: null, reversedCents: 1 })).toBe(false)
    expect(isServiceRefundEligible({ category: 'locadely_error', orderId: 'o', reversedCents: 1 })).toBe(false)
    expect(clampAttributedReversalCents({ deliveryCents: 1000, previouslyRecoveredCents: 900, reversedCents: 500 })).toBe(100)
  })
  it('adopts the Stripe refund after a crash instead of creating a duplicate', async () => {
    let created = 0
    let completed = 0
    const repository: ServiceRefundRepository = {
      claimDue: async () => [{ id: 'sr', claimToken: 'token', attemptCount: 2, stripeChargeId: 'ch', refundCents: 20, idempotencyKey: 'key', livemode: false, reversalId: 'r', orderId: 'o' }],
      complete: async () => { completed += 1; return 'completed' }, fail: async () => undefined, retryLater: async () => undefined
    }
    const provider: MerchantServiceRefundProvider = {
      livemode: false,
      createRefund: async () => { created += 1; return { refundId: 'new', chargeId: 'ch', amountCents: 20, status: 'succeeded' } },
      findRefund: async () => ({ refundId: 'already-created', chargeId: 'ch', amountCents: 20, status: 'succeeded' })
    }
    const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
    await expect(new RunServiceRefundsUseCase(repository, provider, logger).execute({ now: new Date() })).resolves.toMatchObject({ succeeded: 1 })
    expect({ created, completed }).toEqual({ created: 0, completed: 1 })
  })
})
