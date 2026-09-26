import { randomUUID } from 'node:crypto'
import type { Actor, Order } from '../domain/order.js'
import type { OrderRepository } from '../ports/order-repository.js'
import type { DriverCapacityWriter } from '../ports/driver-capacity-writer.js'

export type UnassignOrderCommand = {
  orderId: string
  driverId: string
  expectedVersion: number
  actor: Actor
  correlationId?: string
}

export class UnassignOrderUseCase {
  public constructor(
    private readonly orderRepository: OrderRepository,
    private readonly capacityWriter: DriverCapacityWriter
  ) {}

  public async execute(command: UnassignOrderCommand): Promise<Order> {
    const order = await this.orderRepository.unassign(
      command.orderId,
      command.driverId,
      command.expectedVersion,
      command.actor,
      command.correlationId ?? randomUUID()
    )
    await this.capacityWriter.decrement(command.driverId)
    return order
  }
}
