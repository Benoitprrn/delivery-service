import type { MerchantAccountContactRepository } from '../ports/merchant-repository.js'
import type { MerchantAccountContact } from '../domain/merchant.js'

export class UpdateMerchantAccountContactUseCase {
  public constructor(private readonly contacts: MerchantAccountContactRepository) {}

  public async execute(merchantId: string, contact: MerchantAccountContact): Promise<MerchantAccountContact> {
    return this.contacts.upsertAccountContact(merchantId, contact)
  }
}
