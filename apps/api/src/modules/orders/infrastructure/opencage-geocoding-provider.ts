import {
  AddressNotFoundError,
  GeocodingProviderResponseError,
  GeocodingUnavailableError,
  type GeocodingProvider
} from '../ports/geocoding-provider.js'
import type { LatLng } from '../ports/routing-provider.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export class OpenCageGeocodingProvider implements GeocodingProvider {
  public constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.opencagedata.com/geocode/v1/json'
  ) {}

  public async geocode(address: string): Promise<LatLng> {
    const url = new URL(this.baseUrl)
    url.searchParams.set('q', address)
    url.searchParams.set('key', this.apiKey)
    url.searchParams.set('limit', '1')
    url.searchParams.set('no_annotations', '1')
    // Phase 1 : zone unique Bourg-en-Bresse, en France — restreindre le pays
    // évite qu'une adresse ambiguë se résolve dans le mauvais pays.
    url.searchParams.set('countrycode', 'fr')

    let response: Response
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    } catch (error) {
      throw new GeocodingUnavailableError('Geocoding provider is unavailable', error)
    }

    if (!response.ok) {
      throw new GeocodingProviderResponseError(`Geocoding provider returned HTTP ${response.status}`)
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new GeocodingProviderResponseError('Geocoding provider returned invalid JSON')
    }

    if (!isRecord(body) || !Array.isArray(body.results)) {
      throw new GeocodingProviderResponseError('Geocoding provider response has no results')
    }

    if (body.results.length === 0) {
      throw new AddressNotFoundError(`Address not found: ${address}`)
    }

    const firstResult = body.results[0]
    if (!isRecord(firstResult) || !isRecord(firstResult.geometry)) {
      throw new GeocodingProviderResponseError('Geocoding provider response has invalid geometry')
    }

    const { lat, lng } = firstResult.geometry
    if (
      typeof lat !== 'number' ||
      !Number.isFinite(lat) ||
      typeof lng !== 'number' ||
      !Number.isFinite(lng)
    ) {
      throw new GeocodingProviderResponseError('Geocoding provider response has invalid coordinates')
    }

    return { lat, lng }
  }
}
