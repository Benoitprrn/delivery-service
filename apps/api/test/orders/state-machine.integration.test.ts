import { describe, expect, it } from 'vitest'
import {
  assertTransition,
  canTransition,
  createOrdersModule,
  InvalidTransitionError,
  type OrderStatus
} from '../../src/modules/orders/public.js'
import { createMerchantsModule } from '../../src/modules/merchants/public.js'
import { createZonesModule } from '../../src/modules/zones/public.js'
import { config } from '../../src/platform/config.js'
import { pool } from '../../src/platform/db.js'

const merchantId = '22222222-2222-2222-2222-222222222222'
const driverId = '33333333-3333-3333-3333-333333333333'
const proofPhotoBase64 = '/9j/2Q=='
const orders = createOrdersModule(pool, config.OSRM_URL, config.OPENCAGE_API_KEY)
const { findMerchantById } = createMerchantsModule(pool)
const { findZoneById } = createZonesModule(pool)

const orderStatuses: readonly OrderStatus[] = [
  'CREATED',
  'AVAILABLE',
  'ASSIGNED',
  'COLLECTED',
  'COMPLETED',
  'CANCELLED',
  'RETURNING',
  'RETURNED'
]

async function createOrder() {
  const merchant = await findMerchantById(merchantId)
  if (merchant === null) {
    throw new Error(`Merchant fixture ${merchantId} not found`)
  }
  const zone = await findZoneById(merchant.zoneId)
  if (zone === null) {
    throw new Error(`Zone fixture ${merchant.zoneId} not found`)
  }

  return orders.createOrder({
    merchant,
    zone,
    customerName: 'Client de test',
    customerPhone: '0000000000',
    deliveryAddress: '10 Avenue Alsace-Lorraine, 01000 Bourg-en-Bresse',
    deliveryLat: 46.21,
    deliveryLng: 5.23,
    pickupScheduledAt: { mode: 'asap' }
  })
}

describe('order state machine integration', () => {
  it('executes AVAILABLE -> ASSIGNED -> COLLECTED -> COMPLETED after atomic creation', async () => {
    const available = await createOrder()
    expect(available.status).toBe('AVAILABLE')

    const availableOrders = await orders.listAvailableOrders({ driverId, zoneId: available.zoneId })
    expect(availableOrders.map(order => order.id)).toContain(available.id)

    const assigned = await orders.assignOrder({
      orderId: available.id,
      driverId,
      expectedVersion: available.version,
      actor: { type: 'driver', id: driverId }
    })
    expect(assigned.status).toBe('ASSIGNED')

    const collected = await orders.collectOrder({
      orderId: assigned.id,
      driverId,
      expectedVersion: assigned.version,
      actor: { type: 'driver', id: driverId }
    })
    expect(collected.status).toBe('COLLECTED')

    const completed = await orders.completeOrder({
      orderId: collected.id,
      driverId,
      expectedVersion: collected.version,
      proof: { method: 'photo', imageBase64: proofPhotoBase64 },
      actor: { type: 'driver', id: driverId }
    })
    expect(completed.status).toBe('COMPLETED')
  })

  it('executes COLLECTED -> RETURNING and rejects stale versions and invalid statuses', async () => {
    const available = await createOrder()
    const assigned = await orders.assignOrder({
      orderId: available.id, driverId, expectedVersion: available.version, actor: { type: 'driver', id: driverId }
    })
    const collected = await orders.collectOrder({
      orderId: assigned.id, driverId, expectedVersion: assigned.version, actor: { type: 'driver', id: driverId }
    })
    await expect(orders.returnOrder({
      orderId: collected.id, driverId, expectedVersion: assigned.version, actor: { type: 'driver', id: driverId }
    })).rejects.toThrow('COLLECTED -> RETURNING')

    const returning = await orders.returnOrder({
      orderId: collected.id, driverId, expectedVersion: collected.version, actor: { type: 'driver', id: driverId }
    })
    expect(returning.status).toBe('RETURNING')

    await expect(orders.returnOrder({
      orderId: returning.id, driverId, expectedVersion: returning.version, actor: { type: 'driver', id: driverId }
    })).rejects.toThrow('COLLECTED -> RETURNING')
  })

  it.each([
    ['CREATED', 'AVAILABLE'],
    ['CREATED', 'CANCELLED'],
    ['AVAILABLE', 'CANCELLED'],
    ['ASSIGNED', 'AVAILABLE'],
    ['COLLECTED', 'RETURNING'],
    ['RETURNING', 'RETURNED']
  ] as const satisfies readonly (readonly [OrderStatus, OrderStatus])[])(
    'allows %s -> %s in the state machine',
    (from, to) => {
      expect(canTransition(from, to)).toBe(true)
      expect(() => assertTransition(from, to)).not.toThrow()
    }
  )

  it.each([
    ['CREATED', 'COLLECTED'],
    ['AVAILABLE', 'COMPLETED'],
    ['ASSIGNED', 'CANCELLED'],
    ['COLLECTED', 'CANCELLED'],
    ['RETURNED', 'AVAILABLE']
  ] as const satisfies readonly (readonly [OrderStatus, OrderStatus])[])(
    'rejects %s -> %s',
    (from, to) => {
      expect(canTransition(from, to)).toBe(false)
      expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError)
    }
  )

  it.each(['COMPLETED', 'CANCELLED', 'RETURNED'] as const satisfies readonly OrderStatus[])(
    'does not allow any outgoing transition from terminal %s',
    from => {
      for (const to of orderStatuses) {
        expect(canTransition(from, to)).toBe(false)
        expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError)
      }
    }
  )
})
