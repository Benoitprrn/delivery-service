import { createHash } from 'node:crypto'
import { EInvoiceNetworkBeforeSendError, EInvoiceUnknownOutcomeError, type EInvoiceProvider } from '../ports/einvoice-provider.js'
import type { EInvoiceWorkRepository } from '../ports/einvoice-work-repository.js'
import { mapToEnInvoice } from '../infrastructure/en16931-mapper.js'
import type { DriverEInvoiceReadiness } from './driver-einvoice-readiness.js'
import { canSubmitElectronicInvoice } from '../domain/transmission-readiness.js'
import type { BuyerElectronicAddressResolver } from './resolve-buyer-electronic-address.js'

/** Fakes/providers must classify ambiguity at the transport boundary; generic errors never retry. */
export { EInvoiceNetworkBeforeSendError, EInvoiceUnknownOutcomeError } from '../ports/einvoice-provider.js'
export { canSubmitElectronicInvoice } from '../domain/transmission-readiness.js'

export class RunEInvoiceSubmissionsUseCase {
  public constructor(private readonly repository: EInvoiceWorkRepository, private readonly provider: EInvoiceProvider, private readonly readiness: DriverEInvoiceReadiness, private readonly directory: BuyerElectronicAddressResolver, private readonly electronicAddressScheme: string, private readonly config: { limit?: number; leaseSeconds?: number } = {}) {}
  public async execute(now = new Date()): Promise<void> {
    for (const work of await this.repository.claimDue(now, this.config.leaseSeconds ?? 120, this.config.limit ?? 20)) {
      const driverMandateVerified = work.issuerKind !== 'driver' || (work.issuerDriverId !== null && await this.readiness.isReady(work.issuerDriverId))
      const buyerDirectory = await this.directory.resolve(work.buyerMerchantId, work.buyerSiren, now)
      // The mapper currently falls back to configured seller data, but keep this guard wired to persisted work.
      const sellerElectronicAddressPresent = (work.invoice.seller.electronicAddressScheme !== null && work.invoice.seller.electronicAddressValue !== null) || (this.electronicAddressScheme.trim() !== '' && work.invoice.seller.siren.trim() !== '')
      const readiness = canSubmitElectronicInvoice({ issuerKind: work.issuerKind, sellerElectronicAddressPresent, driverMandateVerified, buyerDirectory })
      if (readiness.status !== 'ready') { await this.repository.retryable({ id: work.id, error: `not_ready:${readiness.status}`, retryAt: retryAt(work.attempts, now), now }); continue }
      const enInvoice = mapToEnInvoice({ ...work.invoice, buyer: { ...work.invoice.buyer, electronicAddress: buyerDirectory.status === 'ready' ? buyerDirectory.electronicAddress : null } }, this.electronicAddressScheme)
      try {
        const submitted = work.documentKind === 'invoice' ? await this.provider.submitInvoice({ externalId: work.externalId, enInvoice }) : await this.provider.submitCreditNote({ externalId: work.externalId, enInvoice })
        await this.repository.submitted({ id: work.id, providerDocumentId: submitted.providerDocumentId, contentType: submitted.contentType, sha256: createHash('sha256').update(submitted.document).digest('hex'), now })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown_einvoice_error'
        if (error instanceof EInvoiceNetworkBeforeSendError) await this.repository.retryable({ id: work.id, error: message, retryAt: retryAt(work.attempts, now), now })
        else if (error instanceof EInvoiceUnknownOutcomeError) await this.repository.unknownOutcome({ id: work.id, error: message, now })
        else await this.repository.failed({ id: work.id, error: message, now })
      }
    }
  }
}

/** Same convention as settlement workers: 1 min, 2 min, 4 min… capped at 6 h; no attempt cap. */
export function retryAt(attempts: number, now: Date): Date {
  const seconds = Math.min(6 * 60 * 60, 60 * 2 ** Math.max(0, attempts - 1))
  return new Date(now.getTime() + seconds * 1_000)
}
