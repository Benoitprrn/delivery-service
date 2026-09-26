import type { DriverInvoiceListItem, InvoiceRepository } from '../ports/invoice-repository.js'

export class GetDriverInvoicesUseCase {
  public constructor(private readonly repository: InvoiceRepository) {}

  public async execute(driverId: string): Promise<DriverInvoiceListItem[]> {
    return this.repository.listForDriver(driverId)
  }
}
