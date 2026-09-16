import type { Pool } from 'pg'
import { GetMerchantUseCase } from './application/get-merchant.js'
import { UpdateMerchantUseCase } from './application/update-merchant.js'
import { UploadMerchantLogoUseCase } from './application/upload-merchant-logo.js'
import { PostgresMerchantRepository } from './infrastructure/postgres-merchant-repository.js'
import { SupabaseMerchantLogoStorage } from './infrastructure/supabase-merchant-logo-storage.js'
import type { MerchantLogoStorage } from './ports/merchant-logo-storage.js'
export { registerMerchantHttpRoutes } from './transport/http/routes.js'

export type { Merchant } from './domain/merchant.js'
export { MerchantNotFoundError } from './domain/errors.js'
export { SupabaseMerchantLogoStorage } from './infrastructure/supabase-merchant-logo-storage.js'
export type { MerchantLogoStorage } from './ports/merchant-logo-storage.js'

export function createMerchantsModule(
  pool: Pool,
  logoStorage: MerchantLogoStorage = {
    upload: async () => {
      throw new Error('Merchant logo storage is not configured')
    }
  }
) {
  const repository = new PostgresMerchantRepository(pool)
  const getMerchantUseCase = new GetMerchantUseCase(repository)
  const updateMerchantUseCase = new UpdateMerchantUseCase(repository)
  const uploadMerchantLogoUseCase = new UploadMerchantLogoUseCase(repository, logoStorage)

  return {
    findMerchantById: repository.findById.bind(repository),
    getMerchant: getMerchantUseCase.execute.bind(getMerchantUseCase),
    updateMerchant: updateMerchantUseCase.execute.bind(updateMerchantUseCase),
    uploadLogo: uploadMerchantLogoUseCase.execute.bind(uploadMerchantLogoUseCase)
  }
}
