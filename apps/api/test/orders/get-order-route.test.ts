import { describe, expect, it, vi } from 'vitest'
import { GetOrderRouteUseCase } from '../../src/modules/orders/application/get-order-route.js'
import { OrderNotFoundError, OrderRouteAccessDeniedError } from '../../src/modules/orders/domain/errors.js'
import type { Order } from '../../src/modules/orders/domain/order.js'
import type { OrderRepository } from '../../src/modules/orders/ports/order-repository.js'
import { RoutingProviderResponseError, type RoutingProvider } from '../../src/modules/orders/ports/routing-provider.js'

const order = {
  id: 'order-1',
  zoneId: 'zone-1',
  pickupLat: 46.2058,
  pickupLng: 5.2255,
  deliveryLat: 46.21,
  deliveryLng: 5.23
} as Order

describe('GetOrderRouteUseCase', () => {
  it('loads the order then requests its GeoJSON geometry from the routing provider', async () => {
    const findById = vi.fn().mockResolvedValue(order)
    const geometry = { type: 'LineString' as const, coordinates: [[5.2255, 46.2058], [5.23, 46.21]] as [number, number][] }
    const getRoute = vi.fn().mockResolvedValue({ distanceM: 1_000, durationS: 300, geometry })
    const useCase = new GetOrderRouteUseCase(
      { findById } as unknown as OrderRepository,
      { getRoute } as RoutingProvider
    )

    await expect(useCase.execute({ orderId: order.id, driverZoneId: order.zoneId })).resolves.toEqual(geometry)
    expect(getRoute).toHaveBeenCalledWith(
      { lat: 46.2058, lng: 5.2255 },
      { lat: 46.21, lng: 5.23 },
      { includeGeometry: true }
    )
  })

  it('rejects a missing order, a cross-zone order, and a route without geometry explicitly', async () => {
    const missing = new GetOrderRouteUseCase(
      { findById: vi.fn().mockResolvedValue(null) } as unknown as OrderRepository,
      { getRoute: vi.fn() } as unknown as RoutingProvider
    )
    await expect(missing.execute({ orderId: order.id, driverZoneId: order.zoneId })).rejects.toBeInstanceOf(OrderNotFoundError)

    const outsideZone = new GetOrderRouteUseCase(
      { findById: vi.fn().mockResolvedValue(order) } as unknown as OrderRepository,
      { getRoute: vi.fn() } as unknown as RoutingProvider
    )
    await expect(outsideZone.execute({ orderId: order.id, driverZoneId: 'other-zone' })).rejects.toBeInstanceOf(OrderRouteAccessDeniedError)

    const withoutGeometry = new GetOrderRouteUseCase(
      { findById: vi.fn().mockResolvedValue(order) } as unknown as OrderRepository,
      { getRoute: vi.fn().mockResolvedValue({ distanceM: 1_000, durationS: 300 }) } as unknown as RoutingProvider
    )
    await expect(withoutGeometry.execute({ orderId: order.id, driverZoneId: order.zoneId })).rejects.toBeInstanceOf(RoutingProviderResponseError)
  })
})
