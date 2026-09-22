import { randomUUID } from 'node:crypto'
import type { Actor, Order } from '../domain/order.js'
import type { OrderRepository } from '../ports/order-repository.js'
import { DriverPayoutAccountNotReadyError } from '../domain/errors.js'
import type { DriverCapacityWriter } from '../ports/driver-capacity-writer.js'
import type { DriverEligibility } from '../ports/driver-eligibility.js'

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
    private readonly capacityWriter: DriverCapacityWriter,
    // Défaut permissif réservé aux tests du module : `app.ts` injecte toujours la vraie garde D-F (fail-closed).
    private readonly eligibility: DriverEligibility = { isEligible: async () => true }
  ) {}

  public async execute(command: AssignOrderCommand): Promise<Order> {
    if (!(await this.eligibility.isEligible(command.driverId))) throw new DriverPayoutAccountNotReadyError()
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
