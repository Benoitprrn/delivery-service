export type LatLng = {
  lat: number
  lng: number
}

export type Route = {
  distanceM: number
  durationS: number
  geometry?: GeoJsonLineString
}

export type GeoJsonLineString = {
  type: 'LineString'
  coordinates: [number, number][]
}

export type GetRouteOptions = {
  includeGeometry?: boolean
}

export interface RoutingProvider {
  getRoute(pickup: LatLng, delivery: LatLng, options?: GetRouteOptions): Promise<Route>
}

export class RouteNotFoundError extends Error {
  public constructor(message = 'No route exists between pickup and delivery') {
    super(message)
    this.name = 'RouteNotFoundError'
  }
}

export class RoutingProviderResponseError extends Error {
  public constructor(message = 'Routing provider returned an invalid response') {
    super(message)
    this.name = 'RoutingProviderResponseError'
  }
}

export class RoutingUnavailableError extends Error {
  public constructor(message: string, cause: unknown) {
    super(message, { cause })
    this.name = 'RoutingUnavailableError'
  }
}
