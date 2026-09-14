import { MerchantNotFoundError } from '../domain/errors.js'
import type { Merchant } from '../domain/merchant.js'
import type { MerchantRepository } from '../ports/merchant-repository.js'

export class GetMerchantUseCase {
  public constructor(private readonly merchantRepository: MerchantRepository) {}

  public async execute(id: string): Promise<Merchant> {
    const merchant = await this.merchantRepository.findById(id)
    if (merchant === null) {
      throw new MerchantNotFoundError(`Merchant ${id} not found`)
    }
    return merchant
  }
}
