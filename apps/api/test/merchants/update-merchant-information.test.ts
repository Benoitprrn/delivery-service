import { describe, expect, it, vi } from 'vitest'
import { updateMerchantBodySchema } from '../../src/modules/merchants/transport/http/schemas.js'
import { UpdateMerchantInformationUseCase } from '../../src/modules/merchants/application/update-merchant-information.js'
import { AddressOutsideZoneError, AmbiguousMerchantZoneError, MerchantNotFoundError } from '../../src/modules/merchants/domain/errors.js'
import { isMerchantInformationComplete } from '../../src/modules/merchants/domain/merchant.js'
import { AddressNotFoundError } from '../../src/modules/geocoding/public.js'

const existing = { id: 'merchant', name: 'Old', zoneId: null, address: null, phonePrimary: null, phoneSecondary: '06 12 34 56 78', logoUrl: null, lat: null, lng: null, onboardingCompleted: false }

function dependencies(containing: unknown = { kind: 'one', zone: { id: 'zone-1', name: 'Bourg', centerLat: 0, centerLng: 0, radiusKm: 10 } }) {
  const client = { query: vi.fn().mockResolvedValue({}), release: vi.fn() }
  const pool = { connect: vi.fn().mockResolvedValue(client) }
  const repository = { findById: vi.fn().mockResolvedValue(existing), updateInformation: vi.fn(async (_id, patch) => ({ ...existing, ...patch })), createIncomplete: vi.fn(), updateLogoUrl: vi.fn() }
  const geocoding = { geocode: vi.fn().mockResolvedValue({ lat: 46.2058, lng: 5.2255 }) }
  const zones = { findContainingPoint: vi.fn().mockResolvedValue(containing) }
  return { client, pool, repository, geocoding, zones }
}

describe('merchant information update', () => {
  it('uses server geocoding and its unique zone in one local transaction', async () => {
    const d = dependencies()
    const useCase = new UpdateMerchantInformationUseCase(d.pool as never, d.repository as never, d.geocoding, d.zones as never)
    await useCase.execute('merchant', { name: 'New', address: '1 Rue Test', phonePrimary: '01 23 45 67 89', phoneSecondary: '09 12 34 56 78' })
    expect(d.geocoding.geocode).toHaveBeenCalledWith('1 Rue Test')
    expect(d.repository.updateInformation).toHaveBeenCalledWith('merchant', expect.objectContaining({ lat: 46.2058, lng: 5.2255, zoneId: 'zone-1', phonePrimary: '01 23 45 67 89', phoneSecondary: '09 12 34 56 78' }), d.client)
    expect(d.client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
  })

  it('retains secondary phone when omitted and clears it when explicitly null', async () => {
    const retained = dependencies(); const clear = dependencies()
    await new UpdateMerchantInformationUseCase(retained.pool as never, retained.repository as never, retained.geocoding, retained.zones as never).execute('merchant', { name: 'New', address: 'A', phonePrimary: '+33 1 23 45 67 89' })
    await new UpdateMerchantInformationUseCase(clear.pool as never, clear.repository as never, clear.geocoding, clear.zones as never).execute('merchant', { name: 'New', address: 'A', phonePrimary: '06 12 34 56 78', phoneSecondary: null })
    expect(retained.repository.updateInformation.mock.calls[0]?.[1].phoneSecondary).toBe('06 12 34 56 78')
    expect(clear.repository.updateInformation.mock.calls[0]?.[1].phoneSecondary).toBeNull()
  })

  it.each([
    [{ kind: 'none' }, AddressOutsideZoneError],
    [{ kind: 'multiple', zones: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }] }, AmbiguousMerchantZoneError]
  ])('does not write when zone lookup is %o', async (containing, ErrorType) => {
    const d = dependencies(containing)
    const useCase = new UpdateMerchantInformationUseCase(d.pool as never, d.repository as never, d.geocoding, d.zones as never)
    await expect(useCase.execute('merchant', { name: 'New', address: 'A', phonePrimary: '01 23 45 67 89' })).rejects.toBeInstanceOf(ErrorType)
    expect(d.repository.updateInformation).not.toHaveBeenCalled()
    expect(d.pool.connect).not.toHaveBeenCalled()
  })

  it('does not write when geocoding cannot find an address', async () => {
    const d = dependencies(); d.geocoding.geocode.mockRejectedValue(new AddressNotFoundError())
    const useCase = new UpdateMerchantInformationUseCase(d.pool as never, d.repository as never, d.geocoding, d.zones as never)
    await expect(useCase.execute('merchant', { name: 'New', address: 'A', phonePrimary: '01 23 45 67 89' })).rejects.toBeInstanceOf(AddressNotFoundError)
    expect(d.repository.updateInformation).not.toHaveBeenCalled()
  })

  it('returns not found without calling the geocoding provider for an absent profile', async () => {
    const d = dependencies()
    d.repository.findById.mockResolvedValue(null)
    const useCase = new UpdateMerchantInformationUseCase(d.pool as never, d.repository as never, d.geocoding, d.zones as never)

    await expect(useCase.execute('missing', { name: 'New', address: 'A', phonePrimary: '01 23 45 67 89' })).rejects.toBeInstanceOf(MerchantNotFoundError)
    expect(d.geocoding.geocode).not.toHaveBeenCalled()
    expect(d.pool.connect).not.toHaveBeenCalled()
  })
})

describe('merchant information completion', () => {
  it('is false for incomplete operational information and true once every required value is present', () => {
    expect(isMerchantInformationComplete(existing)).toBe(false)
    expect(isMerchantInformationComplete({
      ...existing,
      name: 'Shop',
      address: '1 Rue Test',
      lat: 46.2058,
      lng: 5.2255,
      zoneId: 'zone-1',
      phonePrimary: '01 23 45 67 89'
    })).toBe(true)
  })
})

describe('merchant information PATCH schema', () => {
  it.each(['01 23 45 67 89', '06 12 34 56 78', '09 12 34 56 78', '+33 1 23 45 67 89'])('accepts existing French phone format %s', (phonePrimary) => {
    expect(updateMerchantBodySchema.parse({ name: 'Shop', address: '1 Rue Test', phonePrimary })).toEqual({ name: 'Shop', address: '1 Rue Test', phonePrimary })
  })
  it('rejects missing required fields and client coordinates', () => {
    expect(() => updateMerchantBodySchema.parse({ name: 'Shop', address: 'A' })).toThrow()
    expect(() => updateMerchantBodySchema.parse({ name: 'Shop', address: 'A', phonePrimary: '01 23 45 67 89', lat: 46 })).toThrow()
  })
})
