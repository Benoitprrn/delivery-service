import type { Merchant } from '../domain/merchant.js'
import type { MerchantPatch, MerchantRepository } from '../ports/merchant-repository.js'

export class UpdateMerchantUseCase {
  public constructor(private readonly merchantRepository: MerchantRepository) {}

  public async execute(id: string, patch: MerchantPatch): Promise<Merchant> {
    return this.merchantRepository.update(id, patch)
  }
}
