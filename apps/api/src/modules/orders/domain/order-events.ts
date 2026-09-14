import type { Order } from './order.js'

export type DomainEvent = {
  eventType: string
  eventVersion: number
  aggregateVersion: number
  payload: Record<string, unknown>
}

function event(order: Order, eventType: string, payload: Record<string, unknown>): DomainEvent {
  return { eventType, eventVersion: 1, aggregateVersion: order.version, payload }
}

export function buildOrderCreatedEvent(order: Order): DomainEvent {
  return event(order, 'order.created.v1', {
    orderId: order.id,
    zoneId: order.zoneId,
    merchantId: order.merchantId
  })
}

export function buildOrderAssignedEvent(order: Order): DomainEvent {
  return event(order, 'order.assigned.v1', {
    orderId: order.id,
    zoneId: order.zoneId,
    merchantId: order.merchantId,
    driverId: order.driverId
  })
}

export function buildOrderCollectedEvent(order: Order): DomainEvent {
  return event(order, 'order.collected.v1', {
    orderId: order.id,
    zoneId: order.zoneId,
    merchantId: order.merchantId,
    driverId: order.driverId
  })
}

export function buildOrderCompletedEvent(order: Order): DomainEvent {
  return event(order, 'order.completed.v1', {
    orderId: order.id,
    zoneId: order.zoneId,
    merchantId: order.merchantId,
    driverId: order.driverId
  })
}

export function buildOrderReturningEvent(order: Order): DomainEvent {
  return event(order, 'order.returning.v1', {
    orderId: order.id,
    zoneId: order.zoneId,
    merchantId: order.merchantId,
    driverId: order.driverId
  })
}

export function buildOrderReturnedEvent(order: Order): DomainEvent {
  return event(order, 'order.returned.v1', {
    orderId: order.id,
    zoneId: order.zoneId,
    merchantId: order.merchantId,
    driverId: order.driverId
  })
}
