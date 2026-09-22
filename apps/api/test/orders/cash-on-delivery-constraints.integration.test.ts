import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { pool } from '../../src/platform/db.js'

const merchantId = '22222222-2222-2222-2222-222222222222'
const driverId = '33333333-3333-3333-3333-333333333333'
const zoneId = '11111111-1111-1111-1111-111111111111'
const createdOrderIds: string[] = []

type CashOnDelivery = {
  readonly required: boolean
  readonly amountCents?: number | null
  readonly currency?: string | null
  readonly createdAt?: Date | null
  readonly collectedAt?: Date | null
}

afterEach(async () => {
  if (createdOrderIds.length > 0) {
    await pool.query('delete from orders where id = any($1::uuid[])', [createdOrderIds.splice(0)])
  }
})

async function insertOrder({
  status = 'CREATED',
  cashOnDelivery
}: {
  readonly status?: 'CREATED' | 'COLLECTED' | 'COMPLETED'
  readonly cashOnDelivery: CashOnDelivery
}) {
  const id = randomUUID()
  const driver = status === 'CREATED' ? null : driverId
  await pool.query(
    `insert into orders (
       id, merchant_id, driver_id, zone_id, status, customer_name, customer_phone,
       pickup_address, pickup_lat, pickup_lng, delivery_address, delivery_lat, delivery_lng,
       distance_m, duration_s, driver_earning_cents, cash_on_delivery_required, cash_on_delivery_amount_cents,
       cash_on_delivery_currency, cash_on_delivery_created_at, cash_on_delivery_collected_at
     ) values (
       $1, $2, $3, $4, $5, 'Client', '0600000000',
       'Pickup', 46.2, 5.2, 'Delivery', 46.21, 5.23,
       0, 0, 400, $6, $7, $8, $9, $10
     )`,
    [
      id,
      merchantId,
      driver,
      zoneId,
      status,
      cashOnDelivery.required,
      cashOnDelivery.amountCents ?? null,
      cashOnDelivery.currency ?? null,
      cashOnDelivery.createdAt ?? null,
      cashOnDelivery.collectedAt ?? null
    ]
  )
  createdOrderIds.push(id)
  return id
}

const validCashOnDelivery = (): CashOnDelivery => ({
  required: true,
  amountCents: 5000,
  currency: 'eur',
  createdAt: new Date('2026-09-20T12:00:00.000Z')
})

describe('cash on delivery database constraints', () => {
  it('accepts valid COD amounts, including both bounds', async () => {
    await expect(insertOrder({ cashOnDelivery: validCashOnDelivery() })).resolves.toBeDefined()
    await expect(insertOrder({ cashOnDelivery: { ...validCashOnDelivery(), amountCents: 100 } })).resolves.toBeDefined()
    await expect(insertOrder({ cashOnDelivery: { ...validCashOnDelivery(), amountCents: 50000 } })).resolves.toBeDefined()
  })

  it.each([99, 50001])('rejects COD amount %i outside bounds', async amountCents => {
    await expect(insertOrder({ cashOnDelivery: { ...validCashOnDelivery(), amountCents } })).rejects.toThrow()
  })

  it('rejects invalid COD consistency', async () => {
    await expect(insertOrder({ cashOnDelivery: { ...validCashOnDelivery(), currency: 'usd' } })).rejects.toThrow()
    await expect(insertOrder({ cashOnDelivery: { required: false, amountCents: 5000 } })).rejects.toThrow()
    await expect(insertOrder({ cashOnDelivery: { required: true, currency: 'eur' } })).rejects.toThrow()
  })

  it('requires COD collection before COMPLETED and accepts it once recorded', async () => {
    await expect(insertOrder({ status: 'COMPLETED', cashOnDelivery: validCashOnDelivery() })).rejects.toThrow()
    await expect(insertOrder({
      status: 'COMPLETED',
      cashOnDelivery: { ...validCashOnDelivery(), collectedAt: new Date('2026-09-20T12:05:00.000Z') }
    })).resolves.toBeDefined()
  })

  it('keeps snapshot mutable in CREATED then immutable after leaving it', async () => {
    const orderId = await insertOrder({ cashOnDelivery: validCashOnDelivery() })
    await expect(pool.query(
      'update orders set cash_on_delivery_amount_cents = 6000 where id = $1',
      [orderId]
    )).resolves.toBeDefined()
    await pool.query("update orders set status = 'AVAILABLE' where id = $1", [orderId])
    await expect(pool.query(
      'update orders set cash_on_delivery_amount_cents = 7000 where id = $1',
      [orderId]
    )).rejects.toThrow('cash_on_delivery snapshot is immutable after CREATED')
  })

  it('records COD collection once only', async () => {
    const orderId = await insertOrder({ status: 'COLLECTED', cashOnDelivery: validCashOnDelivery() })
    const collectedAt = new Date('2026-09-20T12:05:00.000Z')
    await expect(pool.query(
      'update orders set cash_on_delivery_collected_at = $2 where id = $1',
      [orderId, collectedAt]
    )).resolves.toBeDefined()
    await expect(pool.query(
      'update orders set cash_on_delivery_collected_at = $2 where id = $1',
      [orderId, new Date('2026-09-20T12:06:00.000Z')]
    )).rejects.toThrow('cash_on_delivery_collected_at can only be set once')
  })

  it('allows non-COD completion unchanged', async () => {
    const orderId = await insertOrder({ status: 'COLLECTED', cashOnDelivery: { required: false } })
    await expect(pool.query("update orders set status = 'COMPLETED' where id = $1", [orderId])).resolves.toBeDefined()
  })
})
