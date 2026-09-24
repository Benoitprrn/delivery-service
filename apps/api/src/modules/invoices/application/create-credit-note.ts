import type { CreditNoteDocument, InvoiceRepository } from '../ports/invoice-repository.js'

/** Cas d'usage interne : aucune route publique ne peut créer un avoir dans cette tranche. */
export class CreateCreditNoteUseCase {
  public constructor(private readonly repository: InvoiceRepository) {}
  public async execute(input: { originalInvoiceLineId: string; decisionReference: string; decisionReason: string; lineHtCents: number }): Promise<CreditNoteDocument> {
    if (!Number.isInteger(input.lineHtCents) || input.lineHtCents <= 0) throw new Error('Credit note amount must be a positive integer number of cents')
    if (input.decisionReference.trim() === '' || input.decisionReason.trim() === '') throw new Error('Credit note decision reference and reason are required')
    return this.repository.createCreditNote(input)
  }
}
