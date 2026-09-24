import { MerchantNotFoundError } from '../domain/errors.js'
import type { MerchantLegalInformation, MerchantLegalInformationRepository, SireneVerificationStatus } from '../ports/merchant-repository.js'
import { SiretNotFoundError, SireneProviderResponseError, SireneRestrictedError, SireneUnavailableError, type SireneLegalInformation, type SireneProvider } from '../ports/sirene-provider.js'
import type { MerchantRepository } from '../ports/merchant-repository.js'
import type { ElectronicAddressResolutionTrigger } from '../ports/electronic-address-resolution-trigger.js'

export function normalizeSiret(value: string): string { return value.replace(/[\s.-]/g, '') }
export function isValidSiret(value: string): boolean { if (!/^\d{14}$/.test(value)) return false; let sum=0; for(let i=0;i<14;i++){let n=Number(value[i]); if(i%2===0)n*=2; sum += n>9?n-9:n} return sum%10===0 }
export function isMerchantLegalInformationComplete(value: MerchantLegalInformation | null): boolean { return value !== null && value.siret.length===14 && value.siren.length===9 && value.legalName.trim()!=='' && value.legalAddress.line1.trim()!=='' && value.legalAddress.postalCode.trim()!=='' && value.legalAddress.city.trim()!=='' && (value.billingAddress === null || (value.billingAddress.line1.trim()!=='' && value.billingAddress.postalCode.trim()!=='' && value.billingAddress.city.trim()!=='')) }
export class InvalidSiretError extends Error { public constructor(){super('SIRET must contain 14 valid digits');this.name='InvalidSiretError'} }
export class LookupMerchantLegalInformationUseCase { public constructor(private readonly merchants: MerchantRepository, private readonly sirene: SireneProvider) {} public async execute(id:string,siretInput:string):Promise<SireneLegalInformation>{ if(await this.merchants.findById(id)===null)throw new MerchantNotFoundError(); const siret=normalizeSiret(siretInput);if(!isValidSiret(siret))throw new InvalidSiretError();return this.sirene.lookupBySiret(siret) } }
export type UpdateLegalCommand = { siret:string; legalName:string; legalAddress: MerchantLegalInformation['legalAddress']; billingAddress?: MerchantLegalInformation['billingAddress'] | undefined; vatNumber?: string | null | undefined; vatRegime?: MerchantLegalInformation['vatRegime'] | undefined; legalForm?: string | null | undefined; buyerReference?: string | null | undefined }
export class UpdateMerchantLegalInformationUseCase {
  public constructor(
    private readonly merchants: MerchantRepository,
    private readonly legal: MerchantLegalInformationRepository,
    private readonly sirene: SireneProvider,
    private readonly trigger: ElectronicAddressResolutionTrigger = { onLegalInformationUpdated: () => {} }
  ) {}

  public async execute(id: string, command: UpdateLegalCommand): Promise<MerchantLegalInformation> {
    if (await this.merchants.findById(id) === null) throw new MerchantNotFoundError()

    const siret = normalizeSiret(command.siret)
    if (!isValidSiret(siret)) throw new InvalidSiretError()

    let verification: { status: SireneVerificationStatus; siren: string }
    try {
      const found = await this.sirene.lookupBySiret(siret)
      verification = { status: 'verified', siren: found.siren }
    } catch (error) {
      if (error instanceof SiretNotFoundError) throw error
      if (error instanceof SireneRestrictedError) verification = { status: 'restricted', siren: siret.slice(0, 9) }
      else if (error instanceof SireneUnavailableError || error instanceof SireneProviderResponseError) verification = { status: 'unavailable', siren: siret.slice(0, 9) }
      else throw error
    }

    const current = await this.legal.findLegalInformation(id)
    const saved = await this.legal.upsertLegalInformation({
      merchantId: id,
      siret,
      siren: verification.siren,
      legalName: command.legalName,
      legalAddress: command.legalAddress,
      billingAddress: command.billingAddress === undefined ? (current?.billingAddress ?? null) : command.billingAddress,
      vatNumber: command.vatNumber === undefined ? (current?.vatNumber ?? null) : command.vatNumber,
      vatRegime: command.vatRegime === undefined ? (current?.vatRegime ?? null) : command.vatRegime,
      legalForm: command.legalForm === undefined ? (current?.legalForm ?? null) : command.legalForm,
      buyerReference: command.buyerReference === undefined ? (current?.buyerReference ?? null) : command.buyerReference,
      sireneVerificationStatus: verification.status
    })
    this.trigger.onLegalInformationUpdated({ merchantId: id, siren: verification.siren })
    return saved
  }
}
