import type { ActiveOrderTrackingReader } from '../../orders/public.js'
import type { DriverCapacityRepository } from '../ports/driver-capacity-repository.js'

// Valkey is the fast-path counter. A missing key is not a real zero: rebuild
// it from the orders module and restore the cache for subsequent reads.
export class GetDriverCapacityUseCase {
  public constructor(
    private readonly capacities: DriverCapacityRepository,
    private readonly activeOrders: ActiveOrderTrackingReader = { findActiveTrackingTokensByDriverId: async () => [] }
  ) {}

  public async execute(driverId: string): Promise<number> {
    const cachedCapacity = await this.capacities.get(driverId)
    if (cachedCapacity !== null) return cachedCapacity

    const capacity = (await this.activeOrders.findActiveTrackingTokensByDriverId(driverId)).length
    await this.capacities.set(driverId, capacity)
    return capacity
  }
}
