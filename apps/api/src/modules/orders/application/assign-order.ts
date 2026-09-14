import { randomUUID } from 'node:crypto'
import type { Actor, Order } from '../domain/order.js'
import type { OrderRepository } from '../ports/order-repository.js'

export type AssignOrderCommand = {
  orderId: string
  driverId: string
  expectedVersion: number
  actor: Actor
  correlationId?: string
}

export class AssignOrderUseCase {
  public constructor(private readonly orderRepository: OrderRepository) {}

  public execute(command: AssignOrderCommand): Promise<Order> {
    return this.orderRepository.assign(
      command.orderId,
      command.driverId,
      command.expectedVersion,
      command.actor,
      command.correlationId ?? randomUUID()
    )
  }
}
