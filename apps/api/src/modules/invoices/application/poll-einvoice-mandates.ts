import type { EInvoiceMandateProvider } from '../ports/einvoice-mandate-provider.js'
import type { EInvoiceMandateVerificationRepository } from '../ports/einvoice-mandate-work-repository.js'

type Logger = { error(bindings: Record<string, unknown>, message: string): void }

export class PollEInvoiceMandatesUseCase {
  public constructor(private readonly repository: EInvoiceMandateVerificationRepository, private readonly provider: EInvoiceMandateProvider, private readonly logger: Logger = { error: () => undefined }, private readonly limit = 100) {}

  public async execute(now = new Date()): Promise<void> {
    const mandates = await this.repository.dueForVerification(now, this.limit)
    for (const mandate of mandates) {
      try {
        const result = await this.provider.getMandate(mandate.providerMandateId)
        await this.repository.applyVerification({ id: mandate.id, verificationStatus: result.verificationStatus, now })
      } catch (error) {
        this.logger.error({ err: error, mandateId: mandate.id, providerMandateId: mandate.providerMandateId }, 'E-invoice mandate polling failed')
      }
    }
  }
}
