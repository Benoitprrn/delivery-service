import { randomUUID } from 'node:crypto'
import type { Actor, Order } from '../domain/order.js'
import type { OrderRepository } from '../ports/order-repository.js'
import type { DriverCapacityWriter } from '../ports/driver-capacity-writer.js'

export type AssignOrderCommand = {
  orderId: string
  driverId: string
  expectedVersion: number
  actor: Actor
  correlationId?: string
}

export class AssignOrderUseCase {
  public constructor(
    private readonly orderRepository: OrderRepository,
    private readonly capacityWriter: DriverCapacityWriter
  ) {}

  public async execute(command: AssignOrderCommand): Promise<Order> {
    const order = await this.orderRepository.assign(
      command.orderId,
      command.driverId,
      command.expectedVersion,
      command.actor,
      command.correlationId ?? randomUUID()
    )
    await this.capacityWriter.increment(command.driverId)
    return order
  }
}
