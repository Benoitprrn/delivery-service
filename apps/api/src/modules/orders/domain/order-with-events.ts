import type { OrderEvent } from './order-event.js'
import type { Order } from './order.js'

export type OrderWithEvents = Order & {
  events: OrderEvent[]
}
