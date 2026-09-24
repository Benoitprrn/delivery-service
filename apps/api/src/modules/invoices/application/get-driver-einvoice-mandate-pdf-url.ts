import type { DriverEInvoiceMandateRepository } from '../ports/driver-einvoice-mandate-repository.js'
import type { EInvoiceMandateStorage } from '../ports/einvoice-mandate-storage.js'
export class GetDriverEInvoiceMandatePdfUrlUseCase { public constructor(private readonly mandates: DriverEInvoiceMandateRepository, private readonly storage: EInvoiceMandateStorage) {} public async execute(driverId: string): Promise<string | null> { const mandate = await this.mandates.findCurrent(driverId); return mandate === null ? null : this.storage.createSignedMandatePdfUrl(mandate.signedPdfStoragePath) } }
