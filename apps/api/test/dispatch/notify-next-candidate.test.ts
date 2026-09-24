import { describe, expect, it, vi } from 'vitest'
import { NotifyNextCandidateUseCase } from '../../src/modules/dispatch/application/notify-next-candidate.js'
import type { DriverOrder, Order } from '../../src/modules/orders/public.js'
import type { DispatchPlanner } from '../../src/modules/dispatch/ports/dispatch-planner.js'
import type { DispatchRepository } from '../../src/modules/dispatch/ports/dispatch-repository.js'

const pickupAt = new Date('2035-01-01T12:00:00.000Z')

function order(id: string, status: Order['status']): DriverOrder {
  return {
    id,
    publicReference: '12345678',
    merchantId: 'merchant-1',
    driverId: 'driver-1',
    zoneId: 'zone-1',
    status,
    version: 1,
    customerName: 'Customer',
    customerPhone: '0102030405',
    customerEmail: null,
    pickupScheduledAt: pickupAt,
    orderDetails: null,
    deliveryInstructions: null,
    deliveryAddressComplement: null,
    pickupAddress: 'Restaurant',
    pickupLat: 46.2058,
    pickupLng: 5.2255,
    deliveryAddress: 'Customer address',
    deliveryLat: 46.21,
    deliveryLng: 5.23,
    distanceM: 1_000,
    durationS: 600,
    priceCents: 1_000,
    deliveryCents: 1_000,
    serviceFeeCents: 200,
    cashOnDelivery: {
      required: false,
      amountCents: null,
      currency: null,
      collected: false,
    },
    deliveryProofMethod: null,
    assignedAt: null,
    collectedAt: null,
    completedAt: null,
    createdAt: pickupAt,
    updatedAt: pickupAt,
    merchantName: 'Restaurant',
    merchantPhone: null,
  }
}

describe('NotifyNextCandidateUseCase', () => {
  it('sends assigned shipments and collected/returning delivery-only jobs to VROOM without an active-order limit', async () => {
    const candidateOrder: Order = {
      ...order('candidate', 'AVAILABLE'),
      customerName: 'Customer',
      customerPhone: '0102030405',
    }
    const existingOrders = [
      order('assigned', 'ASSIGNED'),
      order('collected', 'COLLECTED'),
      order('returning', 'RETURNING'),
    ]
    const checkFeasibility = vi
      .fn<DispatchPlanner['checkFeasibility']>()
      .mockResolvedValue({ feasible: true, steps: [] })
    const createOffer = vi.fn().mockResolvedValue({ id: 'offer-1', version: 1 })
    const useCase = new NotifyNextCandidateUseCase(
      {
        createOffer,
        findActiveByDriverId: async () => null,
        findActiveByOrderId: async () => null,
        findById: async () => null,
        accept: async () => {
          throw new Error('not used')
        },
        reject: async () => {
          throw new Error('not used')
        },
        expire: async () => {
          throw new Error('not used')
        },
      } satisfies DispatchRepository,
      { checkFeasibility },
      { getDriverOrders: async () => existingOrders },
      { isAvailable: async () => true },
      { scheduleOfferExpiration: async () => undefined },
      30,
    )

    await expect(
      useCase.execute(candidateOrder, 1, 1, [{ driverId: 'driver-1', lat: 46.2, lng: 5.22 }]),
    ).resolves.toBe(true)

    expect(createOffer).toHaveBeenCalledOnce()
    expect(checkFeasibility).toHaveBeenCalledWith(
      expect.objectContaining({
        existingShipments: [expect.objectContaining({ orderId: 'assigned' })],
        existingDeliveryJobs: [
          expect.objectContaining({
            orderId: 'collected',
            deliveryLocation: { lat: 46.21, lng: 5.23 },
          }),
          expect.objectContaining({
            orderId: 'returning',
            deliveryLocation: { lat: 46.2058, lng: 5.2255 },
          }),
        ],
      }),
    )
  })
})
