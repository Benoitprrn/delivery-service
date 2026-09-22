import type { DriverOrder, Order } from '../../orders/public.js'
import { DispatchOfferConflictError, DispatchPlannerUnavailableError } from '../domain/errors.js'
import type { DispatchDeliveryJob, DispatchPlanner, DispatchShipment } from '../ports/dispatch-planner.js'
import type { DispatchRepository } from '../ports/dispatch-repository.js'

export type DispatchCandidate = { driverId: string; lat: number; lng: number }

export type OfferExpirationScheduler = {
  scheduleOfferExpiration(offerId: string, expectedVersion: number): Promise<void>
}

type OrdersFacade = {
  getDriverOrders(driverId: string): Promise<readonly DriverOrder[]>
}

type DriversFacade = {
  isAvailable(driverId: string): Promise<boolean>
}

function shipment(order: Pick<Order, 'id' | 'pickupLat' | 'pickupLng' | 'deliveryLat' | 'deliveryLng' | 'pickupScheduledAt' | 'createdAt' | 'durationS'>): DispatchShipment {
  const pickupScheduledAt = order.pickupScheduledAt ?? order.createdAt
  return {
    orderId: order.id,
    pickupLocation: { lat: order.pickupLat, lng: order.pickupLng },
    deliveryLocation: { lat: order.deliveryLat, lng: order.deliveryLng },
    pickupScheduledAt,
    deliveryWindowStart: new Date(pickupScheduledAt.getTime() + order.durationS * 1_000)
  }
}

function deliveryJob(order: Pick<Order, 'id' | 'status' | 'pickupLat' | 'pickupLng' | 'deliveryLat' | 'deliveryLng' | 'pickupScheduledAt' | 'createdAt' | 'durationS'>): DispatchDeliveryJob {
  const pickupScheduledAt = order.pickupScheduledAt ?? order.createdAt
  const deliveryWindowStart = new Date(pickupScheduledAt.getTime() + order.durationS * 1_000)
  const deliveryLocation = order.status === 'RETURNING'
    ? { lat: order.pickupLat, lng: order.pickupLng }
    : { lat: order.deliveryLat, lng: order.deliveryLng }
  return { orderId: order.id, deliveryLocation, deliveryWindowStart }
}

export class NotifyNextCandidateUseCase {
  public constructor(
    private readonly repository: DispatchRepository,
    private readonly planner: DispatchPlanner,
    private readonly orders: OrdersFacade,
    private readonly drivers: DriversFacade,
    private readonly expirationScheduler: OfferExpirationScheduler,
    private readonly offerTtlSeconds: number
  ) {}

  public async execute(order: Order, round: number, radiusKm: number | null, candidates: readonly DispatchCandidate[]): Promise<boolean> {
    for (const candidate of candidates) {
      if (!(await this.drivers.isAvailable(candidate.driverId))) continue

      const existingOrders = await this.orders.getDriverOrders(candidate.driverId)
      const existingShipments = existingOrders
        .filter((existingOrder) => existingOrder.status === 'ASSIGNED')
        .map(shipment)
      const existingDeliveryJobs = existingOrders
        .filter((existingOrder) => existingOrder.status === 'COLLECTED' || existingOrder.status === 'RETURNING')
        .map(deliveryJob)
      const feasibility = await this.planner.checkFeasibility({
        driver: { id: candidate.driverId, location: { lat: candidate.lat, lng: candidate.lng } },
        existingShipments,
        existingDeliveryJobs,
        candidateShipment: shipment(order)
      })
      if (!feasibility.feasible) continue

      try {
        if (await this.repository.findActiveByOrderId(order.id) !== null) return true
        const offer = await this.repository.createOffer(
          order.id, candidate.driverId, round, radiusKm,
          new Date(Date.now() + this.offerTtlSeconds * 1_000)
        )
        await this.expirationScheduler.scheduleOfferExpiration(offer.id, offer.version)
        return true
      } catch (error) {
        // The partial unique index protects another dispatch race. Continue with
        // the next candidate; this driver was never notified for this order.
        if (error instanceof DispatchOfferConflictError) continue
        throw error
      }
    }
    return false
  }
}

export { DispatchPlannerUnavailableError }
