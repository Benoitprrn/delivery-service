import type { Pool } from 'pg'
import { GetMerchantUseCase } from './application/get-merchant.js'
import { UpdateMerchantUseCase } from './application/update-merchant.js'
import { PostgresMerchantRepository } from './infrastructure/postgres-merchant-repository.js'

export type { Merchant } from './domain/merchant.js'
export { MerchantNotFoundError } from './domain/errors.js'

export function createMerchantsModule(pool: Pool) {
  const repository = new PostgresMerchantRepository(pool)
  const getMerchantUseCase = new GetMerchantUseCase(repository)
  const updateMerchantUseCase = new UpdateMerchantUseCase(repository)

  return {
    findMerchantById: repository.findById.bind(repository),
    getMerchant: getMerchantUseCase.execute.bind(getMerchantUseCase),
    updateMerchant: updateMerchantUseCase.execute.bind(updateMerchantUseCase)
  }
}
