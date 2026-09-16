import { describe, expect, it, vi } from 'vitest'
import { CreateOrderUseCase } from '../../src/modules/orders/application/create-order.js'
import { DeliveryOutsideZoneError } from '../../src/modules/orders/domain/errors.js'
import type { Order } from '../../src/modules/orders/domain/order.js'
import type { OrderRepository, CreateOrderInput } from '../../src/modules/orders/ports/order-repository.js'
import type { RoutingProvider } from '../../src/modules/orders/ports/routing-provider.js'

const merchant = {
  id: 'merchant',
  zoneId: 'zone',
  name: 'Shop',
  address: '1 Main Street',
  phoneLandline: '0',
  phoneMobile: null,
  logoUrl: null,
  lat: 46.2,
  lng: 5.22
}
const zone = { id: 'zone', name: 'Zone', centerLat: 46.2, centerLng: 5.22, radiusKm: 2 }
const now = new Date('2026-09-13T10:00:00.000Z')

function command() {
  return {
    merchant,
    zone,
    customerName: 'Customer',
    customerPhone: '0',
    deliveryAddress: '2 Main Street',
    deliveryLat: 46.21,
    deliveryLng: 5.23,
    pickupScheduledAt: { mode: 'delay' as const, delayMinutes: 45 },
    orderDetails: 'Two bags',
    deliveryInstructions: 'Ring the bell',
    deliveryAddressComplement: 'Building B'
  }
}

describe('CreateOrderUseCase', () => {
  it('rejects deliveries outside the zone before routing', async () => {
    const getRoute = vi.fn()
    const create = vi.fn()
    const useCase = new CreateOrderUseCase({ create } as unknown as OrderRepository, { getRoute } as unknown as RoutingProvider, { now: () => now })

    await expect(useCase.execute({ ...command(), deliveryLat: 48.8566, deliveryLng: 2.3522 })).rejects.toBeInstanceOf(DeliveryOutsideZoneError)
    expect(getRoute).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('routes before persisting and normalizes scheduling and nullable details', async () => {
    const calls: string[] = []
    let input: CreateOrderInput | undefined
    const routingProvider: RoutingProvider = { getRoute: vi.fn(async () => {
      calls.push('route')
      return { distanceM: 1_000, durationS: 300 }
    }) }
    const repository: OrderRepository = {
      create: vi.fn(async (value: CreateOrderInput) => {
        calls.push('create')
        input = value
        return value as unknown as Order
      })
    } as unknown as OrderRepository
    const useCase = new CreateOrderUseCase(repository, routingProvider, { now: () => now })

    await useCase.execute({ ...command(), orderDetails: undefined, deliveryInstructions: undefined, deliveryAddressComplement: undefined })

    expect(calls).toEqual(['route', 'create'])
    expect(input).toMatchObject({
      pickupScheduledAt: new Date('2026-09-13T10:45:00.000Z'),
      orderDetails: null,
      deliveryInstructions: null,
      deliveryAddressComplement: null
    })
  })
})
