import { randomUUID } from 'node:crypto'
import { DispatchOfferConflictError } from '../domain/errors.js'
import type { DispatchRepository } from '../ports/dispatch-repository.js'

type OrdersFacade = {
  findOrderById(orderId: string): Promise<{ version: number } | null>
  recordDispatchAttempt(orderId: string, attempt: { driverId: string; reason: 'refused'; round: number; refusedAt: Date }, expectedVersion: number): Promise<unknown>
}
type DispatchStarter = { execute(orderId: string): Promise<void> }

export class RejectDispatchOfferUseCase {
  public constructor(private readonly repository: DispatchRepository, private readonly orders: OrdersFacade, private readonly starter: DispatchStarter) {}

  public async execute(offerId: string, driverId: string, expectedVersion: number, correlationId: string = randomUUID()): Promise<void> {
    void correlationId // preserved for the HTTP façade's uniform command signature.
    const offer = await this.repository.findById(offerId)
    if (offer === null || offer.driverId !== driverId) throw new DispatchOfferConflictError(`Dispatch offer ${offerId} does not belong to driver ${driverId}`)
    const rejected = await this.repository.reject(offerId, expectedVersion)
    const order = await this.orders.findOrderById(rejected.orderId)
    if (order === null) throw new DispatchOfferConflictError(`Order ${rejected.orderId} no longer exists`)
    await this.orders.recordDispatchAttempt(rejected.orderId, {
      driverId, reason: 'refused', round: rejected.round, refusedAt: new Date()
    }, order.version)
    await this.starter.execute(rejected.orderId)
  }
}
