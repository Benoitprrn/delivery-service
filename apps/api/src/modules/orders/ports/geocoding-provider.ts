import type { LatLng } from './routing-provider.js'

export interface GeocodingProvider {
  geocode(address: string): Promise<LatLng>
}

export class AddressNotFoundError extends Error {
  public constructor(message = 'Address was not found') {
    super(message)
    this.name = 'AddressNotFoundError'
  }
}

export class GeocodingProviderResponseError extends Error {
  public constructor(message = 'Geocoding provider returned an invalid response') {
    super(message)
    this.name = 'GeocodingProviderResponseError'
  }
}

export class GeocodingUnavailableError extends Error {
  public constructor(message: string, cause: unknown) {
    super(message, { cause })
    this.name = 'GeocodingUnavailableError'
  }
}
