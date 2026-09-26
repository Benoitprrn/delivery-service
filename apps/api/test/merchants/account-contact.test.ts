import { describe, expect, it } from 'vitest'
import { UpdateMerchantAccountContactUseCase } from '../../src/modules/merchants/application/account-contact.js'
import type { MerchantAccountContactRepository } from '../../src/modules/merchants/ports/merchant-repository.js'
import type { MerchantAccountContact } from '../../src/modules/merchants/domain/merchant.js'

class FakeContacts implements MerchantAccountContactRepository {
  public value: MerchantAccountContact | null = null
  public async findAccountContact() { return this.value }
  public async upsertAccountContact(_merchantId: string, contact: MerchantAccountContact) { this.value = contact; return contact }
}

describe('merchant account contact', () => {
  it('returns null before anything has been saved', async () => {
    const repository = new FakeContacts()
    expect(await repository.findAccountContact()).toBeNull()
  })

  it('saves and returns the contact unchanged', async () => {
    const repository = new FakeContacts()
    const contact: MerchantAccountContact = { firstName: 'Alice', lastName: 'Dupont', phone: '0600000001' }
    const result = await new UpdateMerchantAccountContactUseCase(repository).execute('merchant-1', contact)
    expect(result).toEqual(contact)
    expect(await repository.findAccountContact()).toEqual(contact)
  })

  it('overwrites a previous contact on a second save (upsert, not accumulation)', async () => {
    const repository = new FakeContacts()
    const useCase = new UpdateMerchantAccountContactUseCase(repository)
    await useCase.execute('merchant-1', { firstName: 'Alice', lastName: 'Dupont', phone: '0600000001' })
    const updated = await useCase.execute('merchant-1', { firstName: 'Alice', lastName: 'Martin', phone: '0600000002' })
    expect(updated).toEqual({ firstName: 'Alice', lastName: 'Martin', phone: '0600000002' })
  })
})
