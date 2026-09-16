type OrdersFacade = { findStuckAvailableOrders(olderThanMinutes: number): Promise<{ orderId: string }[]> }
type DispatchStarter = { execute(orderId: string): Promise<void> }

export class ReconcileStuckDispatchesUseCase {
  public constructor(private readonly orders: OrdersFacade, private readonly starter: DispatchStarter, private readonly olderThanMinutes = 5) {}

  public async execute(): Promise<void> {
    const stuckOrders = await this.orders.findStuckAvailableOrders(this.olderThanMinutes)
    for (const order of stuckOrders) await this.starter.execute(order.orderId)
  }
}
