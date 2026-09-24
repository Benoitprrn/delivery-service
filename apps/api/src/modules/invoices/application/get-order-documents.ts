import type { InvoiceRepository, OrderDocuments } from '../ports/invoice-repository.js'

export type GetOrderDocumentsCommand =
  | { role: 'merchant'; orderId: string; merchantId: string }
  | { role: 'driver'; orderId: string; driverId: string }

export class GetOrderDocumentsUseCase {
  public constructor(private readonly repository: InvoiceRepository) {}

  public async execute(command: GetOrderDocumentsCommand): Promise<OrderDocuments | null> {
    return command.role === 'merchant'
      ? this.repository.listForMerchantOrder(command.orderId, command.merchantId)
      : this.repository.listForDriverOrder(command.orderId, command.driverId)
  }
}
