import { describe, expect, it } from 'vitest'
import { GetOrderTrackingUseCase } from '../../src/modules/orders/application/get-order-tracking.js'
import type { OrderTrackingRepository } from '../../src/modules/orders/ports/order-tracking-repository.js'

describe('GetOrderTrackingUseCase', () => {
  it('returns a deliberately minimal public projection and calculates the ETA from collection', async () => {
    const collectedAt = new Date('2026-09-14T10:00:00.000Z')
    const repository: OrderTrackingRepository = {
      findTrackingByToken: async () => ({
        status: 'COLLECTED', assignedAt: new Date('2026-09-14T09:50:00.000Z'), collectedAt,
        completedAt: null, durationS: 900, driverPosition: { lat: 46.2, lng: 5.2 }
      })
    }
    await expect(new GetOrderTrackingUseCase(repository).execute('opaque-token')).resolves.toEqual({
      status: 'COLLECTED', assignedAt: '2026-09-14T09:50:00.000Z', collectedAt: '2026-09-14T10:00:00.000Z',
      completedAt: null, estimatedDeliveryAt: '2026-09-14T10:15:00.000Z', driverPosition: { lat: 46.2, lng: 5.2 }
    })
  })

  it('hides positions outside active delivery states and returns null for an unknown token', async () => {
    const repository: OrderTrackingRepository = {
      findTrackingByToken: async (token) => token === 'missing' ? null : ({
        status: 'COMPLETED', assignedAt: new Date('2026-09-14T09:00:00.000Z'),
        collectedAt: new Date('2026-09-14T09:05:00.000Z'), completedAt: new Date('2026-09-14T09:30:00.000Z'),
        durationS: 600, driverPosition: { lat: 46.2, lng: 5.2 }
      })
    }
    const useCase = new GetOrderTrackingUseCase(repository)
    expect(await useCase.execute('missing')).toBeNull()
    expect((await useCase.execute('completed'))?.driverPosition).toBeNull()
  })
})
