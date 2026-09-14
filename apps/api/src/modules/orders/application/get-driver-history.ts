import type { DriverHistoryOrder } from '../domain/order.js'
import type { OrderRepository } from '../ports/order-repository.js'

export class GetDriverHistoryUseCase {
  public constructor(private readonly orderRepository: OrderRepository) {}

  public execute(driverId: string): Promise<DriverHistoryOrder[]> {
    return this.orderRepository.findHistoryByDriverId(driverId)
  }
}
