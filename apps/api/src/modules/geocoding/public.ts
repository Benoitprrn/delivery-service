import { OpenCageGeocodingProvider } from './infrastructure/opencage-geocoding-provider.js'
import type { GeocodingProvider } from './ports/geocoding-provider.js'

export type { GeocodingProvider, LatLng } from './ports/geocoding-provider.js'
export { AddressNotFoundError, GeocodingProviderResponseError, GeocodingUnavailableError } from './ports/geocoding-provider.js'
export { OpenCageGeocodingProvider } from './infrastructure/opencage-geocoding-provider.js'

export function createGeocodingModule(apiKey: string, provider: GeocodingProvider = new OpenCageGeocodingProvider(apiKey)) {
  return { geocode: provider.geocode.bind(provider) }
}
