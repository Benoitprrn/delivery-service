import {
  RouteNotFoundError,
  RoutingProviderResponseError,
  RoutingUnavailableError,
  type LatLng,
  type Route,
  type RoutingProvider,
  type GetRouteOptions,
  type GeoJsonLineString
} from '../ports/routing-provider.js'

function isValidCoordinate({ lat, lng }: LatLng): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseGeometry(value: unknown): GeoJsonLineString {
  if (!isRecord(value) || value.type !== 'LineString' || !Array.isArray(value.coordinates) || value.coordinates.length < 2) {
    throw new RoutingProviderResponseError('Routing provider response has invalid geometry')
  }
  const coordinates: [number, number][] = value.coordinates.map((coordinate) => {
    if (!Array.isArray(coordinate) || coordinate.length !== 2) {
      throw new RoutingProviderResponseError('Routing provider response has invalid geometry coordinate')
    }
    const [lng, lat] = coordinate
    if (typeof lng !== 'number' || typeof lat !== 'number' || !Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      throw new RoutingProviderResponseError('Routing provider response has invalid geometry coordinate')
    }
    return [lng, lat]
  })
  return { type: 'LineString', coordinates }
}

export class OsrmRoutingProvider implements RoutingProvider {
  public constructor(private readonly baseUrl: string) {}

  public async getRoute(pickup: LatLng, delivery: LatLng, options?: GetRouteOptions): Promise<Route> {
    if (!isValidCoordinate(pickup) || !isValidCoordinate(delivery)) {
      throw new RoutingProviderResponseError('Route coordinates are invalid')
    }

    const url = new URL(this.baseUrl)
    url.pathname = `${url.pathname.replace(/\/$/, '')}/route/v1/bicycle/${pickup.lng},${pickup.lat};${delivery.lng},${delivery.lat}`
    if (options?.includeGeometry === true) {
      url.searchParams.set('overview', 'full')
      url.searchParams.set('geometries', 'geojson')
    } else {
      url.searchParams.set('overview', 'false')
    }

    let response: Response
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    } catch (error) {
      throw new RoutingUnavailableError('Routing provider is unavailable', error)
    }

    if (!response.ok) {
      throw new RoutingProviderResponseError(`Routing provider returned HTTP ${response.status}`)
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new RoutingProviderResponseError('Routing provider returned invalid JSON')
    }

    if (!isRecord(body) || body.code !== 'Ok') {
      const osrmCode = isRecord(body) && typeof body.code === 'string' ? body.code : 'unknown'
      throw new RouteNotFoundError(
        `No route between ${JSON.stringify(pickup)} and ${JSON.stringify(delivery)} (OSRM code: ${osrmCode})`
      )
    }

    const routes = body.routes
    const firstRoute = Array.isArray(routes) ? routes[0] : undefined
    if (!isRecord(firstRoute)) {
      throw new RoutingProviderResponseError('Routing provider response has no route')
    }

    const { distance, duration } = firstRoute
    if (
      typeof distance !== 'number' ||
      !Number.isFinite(distance) ||
      distance < 0 ||
      typeof duration !== 'number' ||
      !Number.isFinite(duration) ||
      duration < 0
    ) {
      throw new RoutingProviderResponseError('Routing provider response has invalid distance or duration')
    }

    const route: Route = { distanceM: Math.round(distance), durationS: Math.round(duration) }
    if (options?.includeGeometry === true) {
      route.geometry = parseGeometry(firstRoute.geometry)
    }
    return route
  }
}
