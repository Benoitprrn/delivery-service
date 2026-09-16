import { OrderNotFoundError, OrderRouteAccessDeniedError } from '../domain/errors.js'
import type { GeoJsonLineString, RoutingProvider } from '../ports/routing-provider.js'
import type { OrderRepository } from '../ports/order-repository.js'
import { RoutingProviderResponseError } from '../ports/routing-provider.js'

export type GetOrderRouteCommand = {
  orderId: string
  driverZoneId: string
}

export class GetOrderRouteUseCase {
  public constructor(
    private readonly orderRepository: OrderRepository,
    private readonly routingProvider: RoutingProvider
  ) {}

  public async execute({ orderId, driverZoneId }: GetOrderRouteCommand): Promise<GeoJsonLineString> {
    const order = await this.orderRepository.findById(orderId)
    if (order === null) {
      throw new OrderNotFoundError(`Order ${orderId} not found`)
    }
    if (order.zoneId !== driverZoneId) {
      throw new OrderRouteAccessDeniedError()
    }

    const route = await this.routingProvider.getRoute(
      { lat: order.pickupLat, lng: order.pickupLng },
      { lat: order.deliveryLat, lng: order.deliveryLng },
      { includeGeometry: true }
    )
    if (route.geometry === undefined) {
      throw new RoutingProviderResponseError('Routing provider response has no route geometry')
    }

    return route.geometry
  }
}
