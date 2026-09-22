import type { Pool } from 'pg'
import { GetMerchantUseCase } from './application/get-merchant.js'
import { UpdateMerchantInformationUseCase } from './application/update-merchant-information.js'
import { UploadMerchantLogoUseCase } from './application/upload-merchant-logo.js'
import { ProvisionMerchantUseCase } from './application/provision-merchant.js'
import type { AuthAdmin } from '../auth/public.js'
import { PostgresMerchantRepository } from './infrastructure/postgres-merchant-repository.js'
import type { MerchantLogoStorage } from './ports/merchant-logo-storage.js'
import type { GeocodingProvider } from '../geocoding/public.js'
import type { ZoneRepository } from '../zones/public.js'
import type { SireneProvider } from './ports/sirene-provider.js'
import { UnavailableSireneProvider } from './ports/sirene-provider.js'
import { InseeSireneProvider } from './infrastructure/insee-sirene-provider.js'
import { LookupMerchantLegalInformationUseCase, UpdateMerchantLegalInformationUseCase } from './application/legal-information.js'
export { registerMerchantHttpRoutes } from './transport/http/routes.js'

export type { Merchant } from './domain/merchant.js'
export type { MerchantLegalInformation } from './ports/merchant-repository.js'
export { isMerchantInformationComplete } from './domain/merchant.js'
export { isMerchantLegalInformationComplete } from './application/legal-information.js'
export { MerchantNotFoundError, MerchantProvisioningError, AddressOutsideZoneError, AmbiguousMerchantZoneError } from './domain/errors.js'
export { SupabaseMerchantLogoStorage } from './infrastructure/supabase-merchant-logo-storage.js'
export type { MerchantLogoStorage } from './ports/merchant-logo-storage.js'

/** Builds the internal Sirene capability without exposing its infrastructure to app consumers. */
export function createSireneProvider(apiKey: string | undefined): SireneProvider {
  return apiKey === undefined ? new UnavailableSireneProvider() : new InseeSireneProvider(apiKey)
}

export function createMerchantsModule(
  pool: Pool,
  logoStorage: MerchantLogoStorage = {
    upload: async () => {
      throw new Error('Merchant logo storage is not configured')
    }
  },
  authAdmin?: AuthAdmin,
  geocoding?: GeocodingProvider,
  zones?: ZoneRepository,
  sirene?: SireneProvider
) {
  const repository = new PostgresMerchantRepository(pool)
  const getMerchantUseCase = new GetMerchantUseCase(repository)
  const updateMerchantInformationUseCase = geocoding === undefined || zones === undefined ? undefined : new UpdateMerchantInformationUseCase(pool, repository, geocoding, zones)
  const uploadMerchantLogoUseCase = new UploadMerchantLogoUseCase(repository, logoStorage)
  const provisionMerchantUseCase = new ProvisionMerchantUseCase(repository, authAdmin ?? {
    createUser: async () => { throw new Error('Auth admin is not configured') },
    deleteUser: async () => { throw new Error('Auth admin is not configured') }
  })
  const sireneProvider = sirene ?? new UnavailableSireneProvider()
  const lookupLegalInformationUseCase = new LookupMerchantLegalInformationUseCase(repository, sireneProvider)
  const updateLegalInformationUseCase = new UpdateMerchantLegalInformationUseCase(repository, repository, sireneProvider)

  return {
    findMerchantById: repository.findById.bind(repository),
    getMerchant: getMerchantUseCase.execute.bind(getMerchantUseCase),
    updateMerchantInformation: updateMerchantInformationUseCase === undefined
      ? async () => { throw new Error('Merchant information dependencies are not configured') }
      : updateMerchantInformationUseCase.execute.bind(updateMerchantInformationUseCase),
    uploadLogo: uploadMerchantLogoUseCase.execute.bind(uploadMerchantLogoUseCase),
    provisionMerchant: provisionMerchantUseCase.execute.bind(provisionMerchantUseCase),
    getLegalInformation: repository.findLegalInformation.bind(repository),
    lookupLegalInformation: lookupLegalInformationUseCase.execute.bind(lookupLegalInformationUseCase),
    updateLegalInformation: updateLegalInformationUseCase.execute.bind(updateLegalInformationUseCase)
  }
}
