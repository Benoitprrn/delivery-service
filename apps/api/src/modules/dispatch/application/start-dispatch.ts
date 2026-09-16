import type { Order } from '../../orders/public.js'
import type { DispatchRepository } from '../ports/dispatch-repository.js'
import { DispatchPlannerUnavailableError } from '../domain/errors.js'
import type { DispatchCandidate } from './notify-next-candidate.js'
import { NotifyNextCandidateUseCase } from './notify-next-candidate.js'

type OrdersFacade = {
  findOrderById(orderId: string): Promise<Order | null>
  findDispatchMetadata(orderId: string): Promise<{ dispatchAttempts: { driverId: string }[] } | null>
  findDriversWithActiveOrderForMerchant(merchantId: string, targetPickupAt: Date): Promise<{ driverId: string }[]>
  markDispatchFailed(orderId: string, expectedVersion: number): Promise<Order>
}
type DriversFacade = {
  findLatestDriverLocation(driverId: string): Promise<{ lat: number; lng: number } | null>
  findAvailableWithinRadius(center: { lat: number; lng: number }, radiusKm: number, excludeDriverIds: readonly string[]): Promise<DispatchCandidate[]>
}

function distanceInMeters(origin: { lat: number; lng: number }, candidate: DispatchCandidate): number {
  const radians = (degrees: number): number => degrees * Math.PI / 180
  const latitudeDelta = radians(candidate.lat - origin.lat)
  const longitudeDelta = radians(candidate.lng - origin.lng)
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(origin.lat)) * Math.cos(radians(candidate.lat)) * Math.sin(longitudeDelta / 2) ** 2
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
}

export class StartDispatchUseCase {
  public constructor(
    private readonly repository: DispatchRepository,
    private readonly orders: OrdersFacade,
    private readonly drivers: DriversFacade,
    private readonly notifyNextCandidate: NotifyNextCandidateUseCase
  ) {}

  public async execute(orderId: string): Promise<void> {
    if (await this.repository.findActiveByOrderId(orderId) !== null) return
    const order = await this.orders.findOrderById(orderId)
    if (order === null || order.status !== 'AVAILABLE' || order.driverId !== null) return
    const metadata = await this.orders.findDispatchMetadata(orderId)
    const excluded = new Set(metadata?.dispatchAttempts.map((attempt) => attempt.driverId) ?? [])
    const pickupAt = order.pickupScheduledAt ?? order.createdAt

    const groupage = await this.orders.findDriversWithActiveOrderForMerchant(order.merchantId, pickupAt)
    const groupageCandidates: DispatchCandidate[] = []
    for (const candidate of groupage) {
      if (excluded.has(candidate.driverId)) continue
      const location = await this.drivers.findLatestDriverLocation(candidate.driverId)
      if (location !== null) groupageCandidates.push({ driverId: candidate.driverId, ...location })
    }
    try {
      if (await this.notifyNextCandidate.execute(order, 0, null, groupageCandidates)) return
      for (const radiusKm of [1, 2, 3]) {
        const candidates = await this.drivers.findAvailableWithinRadius(
          { lat: order.pickupLat, lng: order.pickupLng }, radiusKm, [...excluded]
        )
        candidates.sort((left, right) =>
          distanceInMeters({ lat: order.pickupLat, lng: order.pickupLng }, left) -
          distanceInMeters({ lat: order.pickupLat, lng: order.pickupLng }, right)
        )
        if (await this.notifyNextCandidate.execute(order, radiusKm, radiusKm, candidates)) return
      }
    } catch (error) {
      // A VROOM outage blocks the complete dispatch run without excluding anyone.
      if (error instanceof DispatchPlannerUnavailableError) return
      throw error
    }
    await this.orders.markDispatchFailed(order.id, order.version)
  }
}
