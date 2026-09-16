import { randomUUID } from 'node:crypto'
import { DispatchOfferConflictError } from '../domain/errors.js'
import type { DispatchRepository } from '../ports/dispatch-repository.js'

type OrdersFacade = {
  findOrderById(orderId: string): Promise<{ id: string; version: number } | null>
  assignOrder(command: { orderId: string; driverId: string; expectedVersion: number; actor: { type: 'driver'; id: string }; correlationId: string }): Promise<unknown>
}

type DriversFacade = {
  isAvailable(driverId: string): Promise<boolean>
  getCapacity(driverId: string): Promise<number>
}

export class AcceptDispatchOfferUseCase {
  public constructor(
    private readonly repository: DispatchRepository,
    private readonly orders: OrdersFacade,
    private readonly drivers: DriversFacade
  ) {}

  public async execute(offerId: string, driverId: string, expectedVersion: number, correlationId: string = randomUUID()): Promise<void> {
    const offer = await this.repository.findById(offerId)
    if (offer === null || offer.driverId !== driverId) {
      throw new DispatchOfferConflictError(`Dispatch offer ${offerId} does not belong to driver ${driverId}`)
    }
    // Revalidated before accept(): ACTIVE -> ACCEPTED has no way back. Checking
    // after acceptance would strand the offer ACCEPTED with no assignment and
    // no active offer left to expire/retry — orphaning the order, not just
    // rejecting the driver. Checking first lets a failed revalidation leave
    // the offer ACTIVE, so the existing TTL-based expiry still reaches it.
    const [available, capacity] = await Promise.all([
      this.drivers.isAvailable(driverId),
      this.drivers.getCapacity(driverId)
    ])
    if (!available) throw new DispatchOfferConflictError(`Driver ${driverId} is no longer available`)
    if (capacity >= 2) throw new DispatchOfferConflictError(`Driver ${driverId} has reached the maximum active-order capacity`)
    const accepted = await this.repository.accept(offerId, expectedVersion)
    const order = await this.orders.findOrderById(accepted.orderId)
    if (order === null) throw new DispatchOfferConflictError(`Order ${accepted.orderId} no longer exists`)
    // The offer transition and order assignment use independent CAS counters.
    // If assignment conflicts after acceptance, the accepted offer remains recorded;
    // reconciliation/manual recovery is intentionally deferred beyond Phase C.
    await this.orders.assignOrder({
      orderId: order.id,
      driverId,
      expectedVersion: order.version,
      actor: { type: 'driver', id: driverId },
      correlationId
    })
  }
}
