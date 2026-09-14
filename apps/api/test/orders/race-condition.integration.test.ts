import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createOrdersModule,
  OrderConflictError,
  type Order
} from '../../src/modules/orders/public.js'
import { createMerchantsModule } from '../../src/modules/merchants/public.js'
import { createZonesModule } from '../../src/modules/zones/public.js'
import { config } from '../../src/platform/config.js'
import { pool } from '../../src/platform/db.js'

const merchantId = '22222222-2222-2222-2222-222222222222'
const driverId = '33333333-3333-3333-3333-333333333333'
const zoneId = '11111111-1111-1111-1111-111111111111'
const otherDriverId = randomUUID()
const orders = createOrdersModule(pool, config.OSRM_URL, config.OPENCAGE_API_KEY)
const { findMerchantById } = createMerchantsModule(pool)
const { findZoneById } = createZonesModule(pool)

type PoolClientWithProcessId = PoolClient & { processID: number | null }

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

describe('order assignment race condition', () => {
  beforeAll(async () => {
    await pool.query(
      `insert into drivers (id, name, zone_id, is_available)
       values ($1, 'Concurrent test driver', $2, true)`,
      [otherDriverId, zoneId]
    )
  })

  afterAll(async () => {
    await pool.query('delete from drivers where id = $1', [otherDriverId])
  })

  it('allows exactly one driver to assign an AVAILABLE order at the same version', async () => {
    const available = await createOrder()
    expect(available.status).toBe('AVAILABLE')

    const assignmentBackendPids = new Set<number>()
    const captureAssignmentBackend = (client: PoolClient) => {
      const { processID } = client as PoolClientWithProcessId
      if (processID !== null) {
        assignmentBackendPids.add(processID)
      }
    }

    pool.on('acquire', captureAssignmentBackend)
    let results: PromiseSettledResult<Order>[]
    try {
      results = await Promise.allSettled([
        orders.assignOrder({
          orderId: available.id,
          driverId,
          expectedVersion: available.version,
          actor: { type: 'driver', id: driverId }
        }),
        orders.assignOrder({
          orderId: available.id,
          driverId: otherDriverId,
          expectedVersion: available.version,
          actor: { type: 'driver', id: otherDriverId }
        })
      ])

      expect(assignmentBackendPids.size).toBeGreaterThanOrEqual(2)
    } finally {
      pool.off('acquire', captureAssignmentBackend)
    }

    const successful = results.filter(
      (result): result is PromiseFulfilledResult<Order> => result.status === 'fulfilled'
    )
    const conflicts = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )

    expect(successful).toHaveLength(1)
    expect(conflicts).toHaveLength(1)
    expect(successful[0]?.value.status).toBe('ASSIGNED')
    expect(conflicts[0]?.reason).toBeInstanceOf(OrderConflictError)

    const result = await pool.query<{ status: string; driver_id: string; version: number }>(
      'select status::text, driver_id, version from orders where id = $1',
      [available.id]
    )

    expect(result.rows[0]).toEqual({
      status: 'ASSIGNED',
      driver_id: successful[0]?.value.driverId,
      version: available.version + 1
    })
  })
})
