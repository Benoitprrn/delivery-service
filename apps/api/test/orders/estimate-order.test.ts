import { describe, expect, it, vi } from 'vitest'
import { EstimateOrderUseCase } from '../../src/modules/orders/application/estimate-order.js'
import { MerchantOnboardingIncompleteError } from '../../src/modules/orders/domain/errors.js'

describe('EstimateOrderUseCase', () => {
  it('rejects an onboarding-incomplete merchant before geocoding or routing', async () => {
    const geocode = vi.fn()
    const getRoute = vi.fn()
    const useCase = new EstimateOrderUseCase({ geocode } as never, { getRoute } as never)
    await expect(useCase.execute({
      merchant: { id: 'merchant', name: 'Shop', zoneId: null, address: null, phonePrimary: null, phoneSecondary: null, logoUrl: null, lat: null, lng: null, onboardingCompleted: false },
      zone: { id: 'zone', name: 'Zone', centerLat: 0, centerLng: 0, radiusKm: 1 },
      deliveryAddress: 'Anywhere'
    })).rejects.toBeInstanceOf(MerchantOnboardingIncompleteError)
    expect(geocode).not.toHaveBeenCalled()
    expect(getRoute).not.toHaveBeenCalled()
  })

  it('estimates for an onboarding-incomplete merchant with complete location data', async () => {
    const geocode = vi.fn(async () => ({ lat: 46.21, lng: 5.23 }))
    const getRoute = vi.fn(async () => ({ distanceM: 1_000, durationS: 300, geometry: 'encoded-route' }))
    const useCase = new EstimateOrderUseCase({ geocode } as never, { getRoute } as never)

    await expect(useCase.execute({
      merchant: { id: 'merchant', name: 'Shop', zoneId: 'zone', address: '1 Main Street', phonePrimary: null, phoneSecondary: null, logoUrl: null, lat: 46.2, lng: 5.22, onboardingCompleted: false },
      zone: { id: 'zone', name: 'Zone', centerLat: 46.2, centerLng: 5.22, radiusKm: 2 },
      deliveryAddress: '2 Main Street'
    })).resolves.toMatchObject({ distanceM: 1_000, durationS: 300, deliveryLat: 46.21, deliveryLng: 5.23 })

    expect(geocode).toHaveBeenCalledWith('2 Main Street')
    expect(getRoute).toHaveBeenCalledWith({ lat: 46.2, lng: 5.22 }, { lat: 46.21, lng: 5.23 }, { includeGeometry: true })
  })
})
