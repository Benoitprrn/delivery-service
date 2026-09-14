import { afterAll, describe, expect, it } from 'vitest'
import {
  createOrdersModule,
  InvalidZoneAssignmentError,
  OrderConflictError
} from '../../src/modules/orders/public.js'
import { createMerchantsModule } from '../../src/modules/merchants/public.js'
import { createZonesModule } from '../../src/modules/zones/public.js'
import { config } from '../../src/platform/config.js'
import { pool } from '../../src/platform/db.js'

const merchantId = '22222222-2222-2222-2222-222222222222'
const driverId = '33333333-3333-3333-3333-333333333333'
const otherZoneId = '44444444-4444-4444-4444-444444444444'
const otherDriverId = '55555555-5555-5555-5555-555555555555'
const orders = createOrdersModule(pool, config.OSRM_URL, config.OPENCAGE_API_KEY)
const { findMerchantById } = createMerchantsModule(pool)
const { findZoneById } = createZonesModule(pool)

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

describe('order conflicts', () => {
  afterAll(async () => {
    await pool.query('delete from drivers where id = $1', [otherDriverId])
    await pool.query('delete from zones where id = $1', [otherZoneId])
  })

  it('rejects assigning the same AVAILABLE order twice with the same version', async () => {
    const available = await createOrder()
    expect(available.status).toBe('AVAILABLE')

    await orders.assignOrder({
      orderId: available.id,
      driverId,
      expectedVersion: available.version,
      actor: { type: 'driver', id: driverId }
    })

    await expect(
      orders.assignOrder({
        orderId: available.id,
        driverId,
        expectedVersion: available.version,
        actor: { type: 'driver', id: driverId }
      })
    ).rejects.toThrow(`Order ${available.id} could not transition AVAILABLE -> ASSIGNED`)
  })

  it('rejects a stale expected version read before a concurrent successful assignment', async () => {
    const available = await createOrder()
    const staleVersion = available.version
    await orders.assignOrder({
      orderId: available.id,
      driverId,
      expectedVersion: staleVersion,
      actor: { type: 'driver', id: driverId }
    })

    await expect(
      orders.collectOrder({
        orderId: available.id,
        driverId,
        expectedVersion: staleVersion,
        actor: { type: 'driver', id: driverId }
      })
    ).rejects.toBeInstanceOf(OrderConflictError)
  })

  it('maps a driver from another zone to InvalidZoneAssignmentError', async () => {
    await pool.query(
      `insert into zones (id, name, center_lat, center_lng, radius_km)
       values ($1, 'Other zone', 46.3, 5.3, 10) on conflict (id) do nothing`,
      [otherZoneId]
    )
    await pool.query(
      `insert into drivers (id, name, zone_id, is_available)
       values ($1, 'Other driver', $2, true) on conflict (id) do nothing`,
      [otherDriverId, otherZoneId]
    )
    const available = await createOrder()

    await expect(
      orders.assignOrder({
        orderId: available.id,
        driverId: otherDriverId,
        expectedVersion: available.version,
        actor: { type: 'driver', id: otherDriverId }
      })
    ).rejects.toBeInstanceOf(InvalidZoneAssignmentError)
  })

  it('rejects collecting an unassigned AVAILABLE order', async () => {
    const available = await createOrder()

    await expect(
      orders.collectOrder({
        orderId: available.id,
        driverId,
        expectedVersion: available.version,
        actor: { type: 'driver', id: driverId }
      })
    ).rejects.toBeInstanceOf(OrderConflictError)
  })
})
