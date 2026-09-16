import { describe, expect, it, vi } from 'vitest'
import { AcceptDispatchOfferUseCase } from '../../src/modules/dispatch/application/accept-dispatch-offer.js'
import { DispatchOfferConflictError } from '../../src/modules/dispatch/domain/errors.js'
import type { DispatchRepository } from '../../src/modules/dispatch/ports/dispatch-repository.js'

const offer = {
  id: 'offer-1', orderId: 'order-1', driverId: 'driver-1', round: 1,
  radiusKm: 1, status: 'ACTIVE' as const, version: 1,
  expiresAt: new Date(), createdAt: new Date(), respondedAt: null
}

function repository(): DispatchRepository {
  return {
    createOffer: async () => offer,
    findActiveByDriverId: async () => null,
    findActiveByOrderId: async () => null,
    findById: async () => offer,
    accept: async () => ({ ...offer, status: 'ACCEPTED' }),
    reject: async () => offer,
    expire: async () => offer
  }
}

describe('AcceptDispatchOfferUseCase', () => {
  it('does not assign an offer when the driver became unavailable', async () => {
    const assignOrder = vi.fn(async () => undefined)
    const useCase = new AcceptDispatchOfferUseCase(repository(), {
      findOrderById: async () => ({ id: 'order-1', version: 2 }), assignOrder
    }, { isAvailable: async () => false, getCapacity: async () => 0 })

    await expect(useCase.execute('offer-1', 'driver-1', 1)).rejects.toBeInstanceOf(DispatchOfferConflictError)
    expect(assignOrder).not.toHaveBeenCalled()
  })

  it('does not assign an offer when the driver has reached capacity', async () => {
    const assignOrder = vi.fn(async () => undefined)
    const useCase = new AcceptDispatchOfferUseCase(repository(), {
      findOrderById: async () => ({ id: 'order-1', version: 2 }), assignOrder
    }, { isAvailable: async () => true, getCapacity: async () => 2 })

    await expect(useCase.execute('offer-1', 'driver-1', 1)).rejects.toBeInstanceOf(DispatchOfferConflictError)
    expect(assignOrder).not.toHaveBeenCalled()
  })
})
