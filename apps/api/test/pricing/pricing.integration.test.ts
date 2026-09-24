import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { computePriceCents, createPricingSettingsReader } from '../../src/modules/pricing/public.js'
import { PostgresOrderRepository } from '../../src/modules/orders/infrastructure/postgres-order-repository.js'
import { pool } from '../../src/platform/db.js'
import { deleteTestOrders } from '../support/cleanup-orders.js'

const merchantId = '22222222-2222-2222-2222-222222222222'
const zoneId = '11111111-1111-1111-1111-111111111111'
const createdOrderIds: string[] = []

afterEach(async () => {
  if (createdOrderIds.length === 0) {
    return
  }

  await deleteTestOrders(pool, createdOrderIds.splice(0))
})

describe('Postgres generated order price', () => {
  it.each([
    { distanceM: 500, durationS: 120, expectedPriceCents: 400 },
    { distanceM: 2_000, durationS: 300, expectedPriceCents: 400 },
    { distanceM: 5_000, durationS: 900, expectedPriceCents: 615 },
    { distanceM: 10_000, durationS: 1_800, expectedPriceCents: 1_130 }
  ])(
    'matches computePriceCents for $distanceM m and $durationS s',
    async ({ distanceM, durationS, expectedPriceCents }) => {
      const orderId = randomUUID()
      createdOrderIds.push(orderId)

      await pool.query(
        `insert into orders (
           id, merchant_id, zone_id, customer_name, customer_phone, pickup_address, pickup_lat, pickup_lng,
           delivery_address, delivery_lat, delivery_lng, distance_m, duration_s, driver_earning_cents
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0)`,
        [
          orderId,
          merchantId,
          zoneId,
          'Test Client',
          '0600000000',
          'Place de la Grenette, 01000 Bourg-en-Bresse',
          46.2058,
          5.2255,
          '10 Avenue Alsace-Lorraine, 01000 Bourg-en-Bresse',
          46.21,
          5.23,
          distanceM,
          durationS
        ]
      )

      await pool.query(
        'update orders set driver_earning_cents = price_cents where id = $1',
        [orderId]
      )

      const result = await pool.query<{ price_cents: number }>(
        'select price_cents from orders where id = $1',
        [orderId]
      )

      expect(result.rows[0]?.price_cents).toBe(expectedPriceCents)
      const activeSettings = await createPricingSettingsReader(pool).findActive()
      expect(computePriceCents(distanceM, durationS, activeSettings)).toBe(expectedPriceCents)
      expect(result.rows[0]?.price_cents).toBe(computePriceCents(distanceM, durationS, activeSettings))
    }
  )

  it.each([
    { distanceM: 10_000, durationS: 355, overrideBps: null, expectedDeliveryCents: 600, expectedServiceFeeCents: 120, expectedMerchantTotalCents: 720 },
    { distanceM: 5_000, durationS: 150, overrideBps: null, expectedDeliveryCents: 400, expectedServiceFeeCents: 80, expectedMerchantTotalCents: 480 },
    { distanceM: 10_000, durationS: 355, overrideBps: 2_500, expectedDeliveryCents: 600, expectedServiceFeeCents: 150, expectedMerchantTotalCents: 750 }
  ])('freezes delivery and additive service fees for $distanceM m / $durationS s', async ({ distanceM, durationS, overrideBps, expectedDeliveryCents, expectedServiceFeeCents, expectedMerchantTotalCents }) => {
    const repository = new PostgresOrderRepository(pool, createPricingSettingsReader(pool))
    const order = await repository.create({
      merchantId,
      zoneId,
      customerName: 'Test Client',
      customerPhone: '0600000000',
      customerEmail: null,
      pickupScheduledAt: null,
      orderDetails: null,
      deliveryInstructions: null,
      deliveryAddressComplement: null,
      pickupAddress: 'Place de la Grenette, 01000 Bourg-en-Bresse',
      pickupLat: 46.2058,
      pickupLng: 5.2255,
      deliveryAddress: '10 Avenue Alsace-Lorraine, 01000 Bourg-en-Bresse',
      deliveryLat: 46.21,
      deliveryLng: 5.23,
      distanceM,
      durationS,
      merchantServiceFeeRateBpsOverride: overrideBps,
      cashOnDeliveryAmountCents: null,
      actor: { type: 'merchant', id: merchantId },
      correlationId: randomUUID()
    })
    createdOrderIds.push(order.id)

    const result = await pool.query<{
      price_cents: number
      driver_earning_cents: number
      delivery_cents: number | null
      service_fee_cents: number | null
    }>('select price_cents, driver_earning_cents, delivery_cents, service_fee_cents from orders where id = $1', [order.id])

    expect(result.rows[0]).toEqual({
      price_cents: expectedDeliveryCents,
      driver_earning_cents: expectedDeliveryCents,
      delivery_cents: expectedDeliveryCents,
      service_fee_cents: expectedServiceFeeCents
    })
    expect(expectedDeliveryCents + expectedServiceFeeCents).toBe(expectedMerchantTotalCents)
  })
})
