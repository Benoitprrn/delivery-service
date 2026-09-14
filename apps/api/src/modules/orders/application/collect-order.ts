import { randomUUID } from 'node:crypto'
import type { Actor, Order } from '../domain/order.js'
import type { OrderRepository } from '../ports/order-repository.js'

export type CollectOrderCommand = {
  orderId: string
  driverId: string
  expectedVersion: number
  actor: Actor
  correlationId?: string
}

export class CollectOrderUseCase {
  public constructor(private readonly orderRepository: OrderRepository) {}

  public execute(command: CollectOrderCommand): Promise<Order> {
    return this.orderRepository.collect(
      command.orderId,
      command.driverId,
      command.expectedVersion,
      command.actor,
      command.correlationId ?? randomUUID()
    )
  }
}
