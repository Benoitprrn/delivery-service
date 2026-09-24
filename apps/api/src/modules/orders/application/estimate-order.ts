import type { Merchant } from '../../merchants/public.js'
import { computePriceCents, computeServiceFeeCents, type PricingSettingsReader } from '../../pricing/public.js'
import type { Zone } from '../../zones/public.js'
import { DeliveryOutsideZoneError, MerchantOnboardingIncompleteError } from '../domain/errors.js'
import { distanceInMeters } from '../domain/geo.js'
import type { GeocodingProvider } from '../../geocoding/public.js'
import type { RoutingProvider } from '../ports/routing-provider.js'

export type EstimateOrderCommand = {
  merchant: Merchant
  zone: Zone | null
  deliveryAddress: string
}

export class EstimateOrderUseCase {
  public constructor(
    private readonly geocodingProvider: GeocodingProvider,
    private readonly routingProvider: RoutingProvider,
    private readonly pricingSettings: PricingSettingsReader = {
      findActive: async () => { throw new Error('Pricing settings are not configured') },
      findByRuleVersion: async () => { throw new Error('Pricing settings are not configured') }
    }
  ) {}

  public async execute(command: EstimateOrderCommand) {
    if (
      command.merchant.lat === null || command.merchant.lng === null ||
      command.zone === null
    ) throw new MerchantOnboardingIncompleteError()
    const delivery = await this.geocodingProvider.geocode(command.deliveryAddress)
    const distanceToZoneCenterM = distanceInMeters(
      { lat: command.zone.centerLat, lng: command.zone.centerLng },
      delivery
    )
    if (distanceToZoneCenterM > command.zone.radiusKm * 1_000) {
      throw new DeliveryOutsideZoneError()
    }

    const route = await this.routingProvider.getRoute(
      { lat: command.merchant.lat, lng: command.merchant.lng },
      delivery,
      { includeGeometry: true }
    )
    const settings = await this.pricingSettings.findActive()
    const deliveryCents = computePriceCents(route.distanceM, route.durationS, settings)
    const serviceFeeCents = computeServiceFeeCents(
      deliveryCents,
      command.merchant.serviceFeeRateBpsOverride ?? settings.serviceFeeRateBps
    )

    return {
      distanceM: route.distanceM,
      durationS: route.durationS,
      // Kept for existing consumers; it is the standard-order delivery amount.
      priceCents: deliveryCents,
      deliveryCents,
      serviceFeeCents,
      deliveryLat: delivery.lat,
      deliveryLng: delivery.lng,
      geometry: route.geometry
    }
  }
}
