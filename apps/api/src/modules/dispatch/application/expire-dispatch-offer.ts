import type { DispatchRepository } from '../ports/dispatch-repository.js'

type OrdersFacade = {
  findOrderById(orderId: string): Promise<{ version: number } | null>
  recordDispatchAttempt(orderId: string, attempt: { driverId: string; reason: 'timeout'; round: number; refusedAt: Date }, expectedVersion: number): Promise<unknown>
}
type DispatchStarter = { execute(orderId: string): Promise<void> }

export class ExpireDispatchOfferUseCase {
  public constructor(private readonly repository: DispatchRepository, private readonly orders: OrdersFacade, private readonly starter: DispatchStarter) {}

  public async execute(offerId: string, expectedVersion: number): Promise<void> {
    const expired = await this.repository.expire(offerId, expectedVersion)
    const order = await this.orders.findOrderById(expired.orderId)
    if (order === null) return
    await this.orders.recordDispatchAttempt(expired.orderId, {
      driverId: expired.driverId, reason: 'timeout', round: expired.round, refusedAt: new Date()
    }, order.version)
    await this.starter.execute(expired.orderId)
  }
}
