import { randomUUID } from 'node:crypto'
import type { Actor, Order } from '../domain/order.js'
import type { OrderRepository } from '../ports/order-repository.js'

export type ReturnOrderCommand = {
  orderId: string
  driverId: string
  expectedVersion: number
  actor: Actor
  correlationId?: string
}

export class ReturnOrderUseCase {
  public constructor(private readonly orderRepository: OrderRepository) {}

  public execute(command: ReturnOrderCommand): Promise<Order> {
    return this.orderRepository.returnOrder(
      command.orderId,
      command.driverId,
      command.expectedVersion,
      command.actor,
      command.correlationId ?? randomUUID()
    )
  }
}

export type ConfirmReturnCommand = {
  orderId: string
  driverId: string
  expectedVersion: number
  actor: Actor
  correlationId?: string
}

export class ConfirmReturnUseCase {
  public constructor(private readonly orderRepository: OrderRepository) {}

  public execute(command: ConfirmReturnCommand): Promise<Order> {
    return this.orderRepository.confirmReturn(
      command.orderId,
      command.driverId,
      command.expectedVersion,
      command.actor,
      command.correlationId ?? randomUUID()
    )
  }
}
