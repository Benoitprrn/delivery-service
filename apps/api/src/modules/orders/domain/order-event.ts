import type { OrderStatus } from './order-status.js'

export type OrderEvent = {
  id: string
  fromStatus: OrderStatus | null
  toStatus: OrderStatus
  actorType: 'merchant' | 'driver' | 'system'
  actorId: string | null
  createdAt: Date
}
