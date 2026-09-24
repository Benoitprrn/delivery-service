import type { AvailableOrder } from '../domain/order.js'
import type { OrderRepository } from '../ports/order-repository.js'
import type { DriverAvailabilityReader } from '../ports/driver-availability-reader.js'
import type { DriverEligibility } from '../ports/driver-eligibility.js'
import type { DriverInvoiceReadiness } from '../ports/driver-invoice-readiness.js'

export class ListAvailableOrdersUseCase {
  public constructor(
    private readonly orderRepository: OrderRepository,
    private readonly availabilityReader: DriverAvailabilityReader,
    private readonly eligibility: DriverEligibility = { isEligible: async () => true },
    private readonly invoiceReadiness: DriverInvoiceReadiness = { isReady: async () => true }
  ) {}

  public async execute({ driverId, zoneId }: { driverId: string; zoneId: string }): Promise<AvailableOrder[]> {
    if (!(await this.availabilityReader.isAvailable(driverId))) return []
    // D-F : livreur sans compte de paiement prêt = aucune course proposée.
    if (!(await this.eligibility.isEligible(driverId))) return []
    if (!(await this.invoiceReadiness.isReady(driverId))) return []
    return this.orderRepository.findAvailableInZone(zoneId)
  }
}
