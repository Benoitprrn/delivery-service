import type { MerchantAccountContactRepository } from '../ports/merchant-repository.js'

export type MerchantAccountContact = { firstName: string; lastName: string; phone: string }

export class UpdateMerchantAccountContactUseCase {
  public constructor(private readonly contacts: MerchantAccountContactRepository) {}

  public async execute(merchantId: string, contact: MerchantAccountContact): Promise<MerchantAccountContact> {
    return this.contacts.upsertAccountContact(merchantId, contact)
  }
}
