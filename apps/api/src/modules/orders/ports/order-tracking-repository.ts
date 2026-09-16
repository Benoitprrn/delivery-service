import type { OrderStatus } from '../domain/order-status.js'

export type OrderTrackingRecord = {
  status: OrderStatus
  assignedAt: Date | null
  collectedAt: Date | null
  completedAt: Date | null
  durationS: number
  driverPosition: { lat: number; lng: number } | null
}

export interface OrderTrackingRepository {
  findTrackingByToken(token: string): Promise<OrderTrackingRecord | null>
}

/** Minimal projection used for high-frequency GPS fanout. */
export interface ActiveOrderTrackingReader {
  findActiveTrackingTokensByDriverId(driverId: string): Promise<readonly string[]>
}
