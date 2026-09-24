import type { InvoiceRepository } from '../ports/invoice-repository.js'
export class IssueOrderInvoicesUseCase {
  public constructor(private readonly repository: InvoiceRepository) {}
  public async execute(orderId: string) { return this.repository.issueForCompletedOrder(orderId) }
}
