import { randomUUID } from 'node:crypto'
import type { Actor, Order } from '../domain/order.js'
import type { OrderRepository } from '../ports/order-repository.js'
import { DriverPayoutAccountNotReadyError } from '../domain/errors.js'
import type { DriverCapacityWriter } from '../ports/driver-capacity-writer.js'
import type { DriverEligibility } from '../ports/driver-eligibility.js'
import type { DriverInvoiceReadiness } from '../ports/driver-invoice-readiness.js'
import { DriverInvoiceInformationNotReadyError, DriverCompanyProfileNotReadyError, DriverMandateNotReadyError } from '../domain/errors.js'
import type { DriverCompanyProfileReadiness } from '../ports/driver-company-profile-readiness.js'
import type { DriverMandateReadiness } from '../ports/driver-mandate-readiness.js'

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
    private readonly eligibility: DriverEligibility = { isEligible: async () => true },
    private readonly invoiceReadiness: DriverInvoiceReadiness = { isReady: async () => true },
    // Défaut permissif réservé aux tests du module : `app.ts` injecte toujours la vraie garde D-CP (fail-closed).
    private readonly companyProfileReadiness: DriverCompanyProfileReadiness = { isReady: async () => true },
    // Défaut permissif réservé aux tests du module : `app.ts` injecte toujours la vraie garde D-MD (fail-closed).
    private readonly mandateReadiness: DriverMandateReadiness = { isReady: async () => true }
  ) {}

  public async execute(command: AssignOrderCommand): Promise<Order> {
    if (!(await this.eligibility.isEligible(command.driverId))) throw new DriverPayoutAccountNotReadyError()
    if (!(await this.companyProfileReadiness.isReady(command.driverId))) throw new DriverCompanyProfileNotReadyError()
    if (!(await this.mandateReadiness.isReady(command.driverId))) throw new DriverMandateNotReadyError()
    if (!(await this.invoiceReadiness.isReady(command.driverId))) throw new DriverInvoiceInformationNotReadyError()
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
