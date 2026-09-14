import type { DriverEarnings } from '../domain/driver-earnings.js'
import type { OrderRepository } from '../ports/order-repository.js'

export class GetDriverEarningsUseCase {
  public constructor(private readonly orderRepository: OrderRepository) {}

  public execute(driverId: string): Promise<DriverEarnings> {
    return this.orderRepository.getDriverEarnings(driverId)
  }
}
