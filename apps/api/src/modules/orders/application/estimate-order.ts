import type { Merchant } from '../../merchants/public.js'
import { computePriceCents } from '../../pricing/public.js'
import type { Zone } from '../../zones/public.js'
import { DeliveryOutsideZoneError } from '../domain/errors.js'
import { distanceInMeters } from '../domain/geo.js'
import type { GeocodingProvider } from '../ports/geocoding-provider.js'
import type { RoutingProvider } from '../ports/routing-provider.js'

export type EstimateOrderCommand = {
  merchant: Merchant
  zone: Zone
  deliveryAddress: string
}

export class EstimateOrderUseCase {
  public constructor(
    private readonly geocodingProvider: GeocodingProvider,
    private readonly routingProvider: RoutingProvider
  ) {}

  public async execute(command: EstimateOrderCommand) {
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
    const priceCents = computePriceCents(route.distanceM, route.durationS)

    return {
      distanceM: route.distanceM,
      durationS: route.durationS,
      priceCents,
      deliveryLat: delivery.lat,
      deliveryLng: delivery.lng,
      geometry: route.geometry
    }
  }
}
