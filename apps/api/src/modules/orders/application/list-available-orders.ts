import type { AvailableOrder } from '../domain/order.js'
import type { OrderRepository } from '../ports/order-repository.js'
import type { DriverAvailabilityReader } from '../ports/driver-availability-reader.js'

export class ListAvailableOrdersUseCase {
  public constructor(
    private readonly orderRepository: OrderRepository,
    private readonly availabilityReader: DriverAvailabilityReader
  ) {}

  public async execute({ driverId, zoneId }: { driverId: string; zoneId: string }): Promise<AvailableOrder[]> {
    if (!(await this.availabilityReader.isAvailable(driverId))) return []
    return this.orderRepository.findAvailableInZone(zoneId)
  }
}
