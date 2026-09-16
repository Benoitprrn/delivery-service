import type { OrderTrackingRepository } from '../ports/order-tracking-repository.js'

export type PublicOrderTracking = {
  status: import('../domain/order-status.js').OrderStatus
  assignedAt: string | null
  collectedAt: string | null
  completedAt: string | null
  estimatedDeliveryAt: string | null
  driverPosition: { lat: number; lng: number } | null
}

export class GetOrderTrackingUseCase {
  public constructor(private readonly repository: OrderTrackingRepository) {}

  public async execute(token: string): Promise<PublicOrderTracking | null> {
    const order = await this.repository.findTrackingByToken(token)
    if (order === null) return null

    // ETA starts at collection when available; while waiting at pickup it starts
    // at assignment. It remains unknown before a driver has accepted the order.
    const etaBase = order.collectedAt ?? order.assignedAt
    const canExposePosition = order.status === 'ASSIGNED' || order.status === 'COLLECTED'
    return {
      status: order.status,
      assignedAt: order.assignedAt?.toISOString() ?? null,
      collectedAt: order.collectedAt?.toISOString() ?? null,
      completedAt: order.completedAt?.toISOString() ?? null,
      estimatedDeliveryAt: etaBase === null ? null : new Date(etaBase.getTime() + order.durationS * 1_000).toISOString(),
      driverPosition: canExposePosition ? order.driverPosition : null
    }
  }
}
