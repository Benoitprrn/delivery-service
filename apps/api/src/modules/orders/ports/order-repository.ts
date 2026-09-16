import type { Actor, AvailableOrder, DriverHistoryOrder, DriverOrder, MerchantOrder, Order } from '../domain/order.js'
import type { DriverEarnings } from '../domain/driver-earnings.js'
import type { ProofOfDeliveryAsset } from '../domain/proof-of-delivery.js'
import type { ActiveOrderTrackingReader, OrderTrackingRepository } from './order-tracking-repository.js'
import type { DispatchMetadata } from '../domain/dispatch.js'

export type CreateOrderInput = {
  merchantId: string
  zoneId: string
  customerName: string
  customerPhone: string
  customerEmail: string | null
  pickupScheduledAt: Date | null
  orderDetails: string | null
  deliveryInstructions: string | null
  deliveryAddressComplement: string | null
  pickupAddress: string
  pickupLat: number
  pickupLng: number
  deliveryAddress: string
  deliveryLat: number
  deliveryLng: number
  distanceM: number
  durationS: number
  actor: Actor
  correlationId: string
}

export interface OrderRepository extends OrderTrackingRepository, ActiveOrderTrackingReader {
  create(input: CreateOrderInput): Promise<Order>
  findById(orderId: string): Promise<Order | null>
  findDispatchMetadata(orderId: string): Promise<DispatchMetadata | null>
  findStuckAvailableOrders(olderThanMinutes: number): Promise<{ orderId: string; merchantId: string }[]>
  findByMerchantId(merchantId: string): Promise<MerchantOrder[]>
  findDriverOrderById(orderId: string): Promise<DriverOrder | null>
  findActiveByDriverId(driverId: string): Promise<DriverOrder[]>
  findHistoryByDriverId(driverId: string): Promise<DriverHistoryOrder[]>
  getDriverEarnings(driverId: string): Promise<DriverEarnings>
  findAvailableInZone(zoneId: string): Promise<AvailableOrder[]>
  findDriversWithActiveOrderForMerchant(
    merchantId: string,
    targetPickupAt: Date
  ): Promise<{ driverId: string; orderId: string; pickupScheduledAt: Date | null }[]>
  recordDispatchAttempt(
    orderId: string,
    attempt: { driverId: string; reason: 'refused' | 'timeout'; round: number; refusedAt: Date },
    expectedVersion: number
  ): Promise<Order>
  markDispatchFailed(orderId: string, expectedVersion: number): Promise<Order>
  assign(
    orderId: string,
    driverId: string,
    expectedVersion: number,
    actor: Actor,
    correlationId: string
  ): Promise<Order>
  collect(orderId: string, driverId: string, expectedVersion: number, actor: Actor, correlationId: string): Promise<Order>
  complete(
    orderId: string,
    driverId: string,
    expectedVersion: number,
    proof: { method: 'code'; code: string } | ProofOfDeliveryAsset,
    actor: Actor,
    correlationId: string
  ): Promise<Order>
  returnOrder(orderId: string, driverId: string, expectedVersion: number, actor: Actor, correlationId: string): Promise<Order>
  confirmReturn(orderId: string, driverId: string, expectedVersion: number, actor: Actor, correlationId: string): Promise<Order>
}
