import { InvalidMerchantLogoError } from '../domain/invalid-merchant-logo-error.js'
import type { Merchant } from '../domain/merchant.js'
import type { MerchantLogoStorage } from '../ports/merchant-logo-storage.js'
import type { MerchantRepository } from '../ports/merchant-repository.js'

const MAX_LOGO_BYTES = 2 * 1024 * 1024

export class UploadMerchantLogoUseCase {
  public constructor(
    private readonly merchantRepository: MerchantRepository,
    private readonly logoStorage: MerchantLogoStorage
  ) {}

  public async execute(merchantId: string, content: Buffer, contentType: string): Promise<Merchant> {
    if (content.length === 0 || content.length > MAX_LOGO_BYTES) {
      throw new InvalidMerchantLogoError('Merchant logo must be no larger than 2 MB')
    }
    if (contentType !== 'image/jpeg' && contentType !== 'image/png') {
      throw new InvalidMerchantLogoError('Merchant logo must be a JPEG or PNG image')
    }
    const logoUrl = await this.logoStorage.upload({ merchantId, content, contentType })
    return this.merchantRepository.updateLogoUrl(merchantId, logoUrl)
  }
}
