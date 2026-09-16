import type { OrderStatus } from './order-status.js'

export type Actor = {
  type: 'merchant' | 'driver' | 'system'
  id?: string
}

export type DeliveryProofMethod = 'code' | 'signature' | 'photo'

export type MerchantProofAsset = {
  kind: Exclude<DeliveryProofMethod, 'code'>
  contentBase64: string
  contentType: 'image/jpeg' | 'image/png'
  createdAt: Date
}

export type Order = {
  id: string
  merchantId: string
  driverId: string | null
  zoneId: string
  status: OrderStatus
  version: number
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
  priceCents: number
  deliveryProofMethod: DeliveryProofMethod | null
  assignedAt: Date | null
  collectedAt: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** Response shape scoped to a merchant. */
export type MerchantOrder = Order & {
  trackingToken: string
  events: import('./order-event.js').OrderEvent[]
  driverName: string | null
  driverPhone: string | null
  proofAsset: MerchantProofAsset | null
  dispatchFailed: boolean
  /**
   * TODO: TWILIO — temporary display-only code. It is deliberately absent from
   * every other order DTO and is removed as soon as SMS delivery is available.
   */
  deliveryCode?: string
}

/**
 * Driver-facing order data. Recipient identity is intentionally withheld until
 * collection has been confirmed, while merchant contact details are always
 * available to let the driver arrange pickup.
 */
export type DriverOrder = Omit<Order, 'customerName' | 'customerPhone'> & {
  customerName: string | null
  customerPhone: string | null
  merchantName: string
  merchantPhone: string | null
}

export type DriverHistoryOrder = DriverOrder & {
  driverEarningCents: number
}

export type AvailableOrder = DriverOrder
