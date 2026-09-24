import { legalDataDrift } from '../domain/mandate-acceptance.js'
import type { DriverEInvoiceMandateRepository } from '../ports/driver-einvoice-mandate-repository.js'
import type { MandateTemplateRepository } from '../ports/mandate-template-repository.js'
import type { DriverLegalInformationReader } from '../ports/driver-legal-information-reader.js'
import type { DriverProfileReader } from '../ports/driver-profile-reader.js'
import type { PlatformLegalIdentityReader } from '../ports/platform-legal-identity-reader.js'
import { substituteMandateTemplate } from '../domain/mandate-template.js'
import { complete, joinAddress } from './accept-driver-einvoice-mandate.js'
export type MandateBlockedReason = 'legal_information_missing' | 'driver_name_missing' | 'template_not_configured' | 'platform_identity_missing'
export class GetDriverEInvoiceMandateStatusUseCase {
  public constructor(private readonly mandates: DriverEInvoiceMandateRepository, private readonly legalInformation: DriverLegalInformationReader, private readonly templates: MandateTemplateRepository, private readonly driverProfile: DriverProfileReader, private readonly platformIdentity: PlatformLegalIdentityReader) {}
  public async execute(driverId: string) {
    const [mandate, liveLegalInformation, template, profile, seller] = await Promise.all([this.mandates.findCurrent(driverId), this.legalInformation.findDriverLegalInformation(driverId), this.templates.findCurrent(), this.driverProfile.findDriverProfile(driverId), this.platformIdentity.findPlatformLegalIdentity()])
    const blockedReason: MandateBlockedReason | null = !complete(liveLegalInformation) ? 'legal_information_missing' : profile === null ? 'driver_name_missing' : template === null ? 'template_not_configured' : seller === null ? 'platform_identity_missing' : null
    const previewText = mandate !== null || blockedReason !== null || liveLegalInformation === null || template === null || profile === null || seller === null ? null : substituteMandateTemplate(template.text, { driver_first_name: profile.firstName, driver_last_name: profile.lastName, driver_legal_name: liveLegalInformation.professionalName, driver_siren: liveLegalInformation.siren, driver_siret: liveLegalInformation.siret, driver_legal_address: joinAddress([liveLegalInformation.legalAddress.line1, liveLegalInformation.legalAddress.line2, `${liveLegalInformation.legalAddress.postalCode} ${liveLegalInformation.legalAddress.city}`, liveLegalInformation.legalAddress.countryCode]), driver_vat_number_or_not_applicable: liveLegalInformation.vatNumber ?? 'Non applicable', platform_legal_address: joinAddress([seller.addressLine1, seller.addressLine2, `${seller.postalCode} ${seller.city}`, seller.countryCode]), signer_first_name: '[à renseigner à la signature]', signer_last_name: '[à renseigner à la signature]', signed_at: '[à la signature]', mandate_version: String(template.version), mandate_reference: '[généré à la signature]', handwritten_signature: '[votre signature]' })
    return { mandateExists: mandate !== null, providerVerificationStatus: mandate?.providerVerificationStatus ?? null, submissionStatus: mandate?.submissionStatus ?? null, lastError: mandate?.lastError ?? null, drift: mandate === null || liveLegalInformation === null ? null : legalDataDrift(mandate.snapshot, liveLegalInformation), template: template === null ? null : { text: template.text, version: template.version }, liveLegalInformation, blockedReason, previewText }
  }
}
