import { retryAt } from './run-einvoice-submissions.js'
import { EInvoiceNetworkBeforeSendError, EInvoiceUnknownOutcomeError } from '../ports/einvoice-provider.js'
import type { EInvoiceMandateProvider } from '../ports/einvoice-mandate-provider.js'
import type { EInvoiceMandateStorage } from '../ports/einvoice-mandate-storage.js'
import type { EInvoiceMandateWorkRepository } from '../ports/einvoice-mandate-work-repository.js'

export class RunEInvoiceMandateSubmissionsUseCase {
  public constructor(private readonly repository: EInvoiceMandateWorkRepository, private readonly storage: EInvoiceMandateStorage, private readonly provider: EInvoiceMandateProvider, private readonly config: { grantorNumberScheme: 'fr_siren' | 'sandbox'; limit?: number; leaseSeconds?: number }) {}

  public async execute(now = new Date()): Promise<void> {
    const work = await this.repository.claimDue(now, this.config.leaseSeconds ?? 60, this.config.limit ?? 20)
    for (const item of work) {
      try {
        const pdf = await this.storage.downloadMandatePdf(item.signedPdfStoragePath)
        // Super PDP identifies a `direction=out` grantor by SIREN only, regardless of scheme
        // (docs/work/invoicing-preparation-plan.md §7.2: "identifié uniquement par son SIREN" —
        // the `fr_siren` scheme name itself says so). Never SIRET, which the port's grantorSiret
        // field is not even meant for here.
        const mandate = await this.provider.createMandate({ grantorNumber: item.grantorSiren, grantorNumberScheme: this.config.grantorNumberScheme, grantorLegalName: item.grantorLegalName, pdf })
        await this.repository.submitted({ id: item.id, providerMandateId: mandate.id, now })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown_einvoice_mandate_error'
        if (error instanceof EInvoiceNetworkBeforeSendError) await this.repository.retryable({ id: item.id, error: message, retryAt: retryAt(item.attempts, now), now })
        else if (error instanceof EInvoiceUnknownOutcomeError) await this.repository.unknownOutcome({ id: item.id, error: message, now })
        else await this.repository.failed({ id: item.id, error: message, now })
      }
    }
  }
}
