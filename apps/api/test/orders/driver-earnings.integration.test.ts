import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createOrdersModule } from '../../src/modules/orders/public.js'
import { config } from '../../src/platform/config.js'
import { pool } from '../../src/platform/db.js'

const merchantId = '22222222-2222-2222-2222-222222222222'
const zoneId = '11111111-1111-1111-1111-111111111111'
const createdOrderIds: string[] = []
const createdDriverIds: string[] = []
const orders = createOrdersModule(pool, config.OSRM_URL, config.OPENCAGE_API_KEY)

afterEach(async () => {
  if (createdOrderIds.length > 0) {
    await pool.query('delete from orders where id = any($1::uuid[])', [createdOrderIds.splice(0)])
  }
  if (createdDriverIds.length > 0) {
    await pool.query('delete from drivers where id = any($1::uuid[])', [createdDriverIds.splice(0)])
  }
})

describe('driver earnings', () => {
  it('aggregates all completed orders for one driver and returns the 20 most recent only', async () => {
    const driverId = randomUUID()
    const otherDriverId = randomUUID()
    createdDriverIds.push(driverId, otherDriverId)
    await pool.query(
      `insert into drivers (id, name, zone_id) values
       ($1, 'Wallet driver', $3), ($2, 'Other wallet driver', $3)`,
      [driverId, otherDriverId, zoneId]
    )

    const expected = Array.from({ length: 22 }, (_, index) => ({
      id: randomUUID(),
      completedAt: new Date(Date.UTC(2026, 8, 1, 12, 0, index)),
      earningCents: 400 + index,
      deliveryAddress: `Address ${index}`
    }))
    const otherOrderId = randomUUID()
    createdOrderIds.push(...expected.map((order) => order.id), otherOrderId)

    for (const order of expected) {
      await pool.query(
        `insert into orders (
           id, merchant_id, driver_id, zone_id, status, customer_name, customer_phone,
           pickup_address, pickup_lat, pickup_lng, delivery_address, delivery_lat, delivery_lng,
           distance_m, duration_s, driver_earning_cents, completed_at
         ) values ($1, $2, $3, $4, 'COMPLETED', 'Client', '0600000000',
           'Pickup', 46.2, 5.2, $5, 46.21, 5.23, 0, 0, $6, $7)`,
        [order.id, merchantId, driverId, zoneId, order.deliveryAddress, order.earningCents, order.completedAt]
      )
    }
    await pool.query(
      `insert into orders (
         id, merchant_id, driver_id, zone_id, status, customer_name, customer_phone,
         pickup_address, pickup_lat, pickup_lng, delivery_address, delivery_lat, delivery_lng,
         distance_m, duration_s, driver_earning_cents, completed_at
       ) values ($1, $2, $3, $4, 'COMPLETED', 'Client', '0600000000',
         'Pickup', 46.2, 5.2, 'Other address', 46.21, 5.23, 0, 0, 9999, now())`,
      [otherOrderId, merchantId, otherDriverId, zoneId]
    )

    const earnings = await orders.getDriverEarnings(driverId)

    expect(earnings).toMatchObject({
      totalEarningCents: expected.reduce((total, order) => total + order.earningCents, 0),
      completedOrderCount: expected.length,
      currency: 'EUR',
      paymentMethod: 'bank_transfer',
      paymentStatus: 'provisional'
    })
    expect(earnings.recentCompletedOrders).toHaveLength(20)
    expect(earnings.recentCompletedOrders.map((order) => order.id)).toEqual(
      [...expected]
        .sort((left, right) => right.completedAt.getTime() - left.completedAt.getTime())
        .slice(0, 20)
        .map((order) => order.id)
    )
    expect(earnings.recentCompletedOrders.some((order) => order.id === otherOrderId)).toBe(false)
  })
})
