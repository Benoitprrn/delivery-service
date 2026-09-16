import type { DispatchOffer } from '../domain/dispatch-offer.js'

export interface DispatchRepository {
  createOffer(orderId: string, driverId: string, round: number, radiusKm: number | null, expiresAt: Date): Promise<DispatchOffer>
  findActiveByDriverId(driverId: string): Promise<DispatchOffer | null>
  findActiveByOrderId(orderId: string): Promise<DispatchOffer | null>
  findById(offerId: string): Promise<DispatchOffer | null>
  accept(offerId: string, expectedVersion: number): Promise<DispatchOffer>
  reject(offerId: string, expectedVersion: number): Promise<DispatchOffer>
  expire(offerId: string, expectedVersion: number): Promise<DispatchOffer>
}
