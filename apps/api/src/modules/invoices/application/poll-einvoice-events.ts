import type { EInvoiceProvider } from '../ports/einvoice-provider.js'
import type { EInvoiceEventsRepository } from '../ports/einvoice-work-repository.js'
export class PollEInvoiceEventsUseCase {
  public constructor(private readonly repository: EInvoiceEventsRepository, private readonly provider: EInvoiceProvider) {}

  public async execute(now = new Date()): Promise<void> {
    let cursor = await this.repository.cursor()
    while (true) {
      const page = await this.provider.listEvents(cursor)
      await this.repository.applyEvents({ events: page.events.map((event) => ({ id: event.id, invoiceId: event.invoiceId, statusCode: event.statusCode, statusText: event.statusText, createdAt: event.createdAt })), now })
      if (!page.hasAfter) return
      const nextCursor = Math.max(cursor, ...page.events.map((event) => event.id))
      if (nextCursor === cursor) throw new Error('Super PDP event pagination did not advance its cursor')
      cursor = nextCursor
    }
  }
}
