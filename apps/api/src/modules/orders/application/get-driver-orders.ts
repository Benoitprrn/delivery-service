import type { DriverOrder } from '../domain/order.js'
import type { OrderRepository } from '../ports/order-repository.js'

export class GetDriverOrdersUseCase {
  public constructor(private readonly orderRepository: OrderRepository) {}

  public execute(driverId: string): Promise<DriverOrder[]> {
    return this.orderRepository.findActiveByDriverId(driverId)
  }
}
