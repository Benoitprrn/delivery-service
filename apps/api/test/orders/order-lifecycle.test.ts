import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createMerchantsModule } from '../../src/modules/merchants/public.js'
import { createZonesModule } from '../../src/modules/zones/public.js'
import {
  CashOnDeliveryAlreadyCollectedError,
  CashOnDeliveryNotRequiredError,
  CashOnDeliveryPaymentRequiredError,
  createOrdersModule,
  DeliveryCodeExpiredError,
  DeliveryCodeInvalidError,
  DeliveryCodeLockedError,
  OrderConflictError
} from '../../src/modules/orders/public.js'
import { computePriceCents } from '../../src/modules/pricing/public.js'
import { config } from '../../src/platform/config.js'
import { pool } from '../../src/platform/db.js'
import { deleteTestOrders } from '../support/cleanup-orders.js'

const merchantId = '22222222-2222-2222-2222-222222222222'
const driverId = '33333333-3333-3333-3333-333333333333'
const otherDriverId = '44444444-4444-4444-4444-444444444444'
const proofPhotoBase64 = '/9j/2Q=='
const zoneId = '11111111-1111-1111-1111-111111111111'
const createdOrderIds: string[] = []
const orders = createOrdersModule(pool, config.OSRM_URL, async () => ({ lat: 46.2058, lng: 5.2255 }))
const { findMerchantById } = createMerchantsModule(pool)
const { findZoneById } = createZonesModule(pool)

async function transitionsFor(orderId: string) {
  const result = await pool.query<{ from_status: string | null; to_status: string }>(
    'select from_status, to_status from order_events where order_id = $1 order by created_at, id',
    [orderId]
  )
  return result.rows
}

async function outboxFor(orderId: string) {
  const result = await pool.query<{ event_type: string; aggregate_version: number }>(
    `select event_type, aggregate_version from outbox_event
     where aggregate_id = $1 order by aggregate_version`,
    [orderId]
  )
  return result.rows
}

async function createOrder(cashOnDelivery?: { amountCents: number }) {
  const merchant = await findMerchantById(merchantId)
  if (merchant === null) {
    throw new Error(`Merchant fixture ${merchantId} not found`)
  }
  if (merchant.zoneId === null) throw new Error(`Merchant fixture ${merchantId} has no zone`)
  const zone = await findZoneById(merchant.zoneId)
  if (zone === null) {
    throw new Error(`Zone fixture ${merchant.zoneId} not found`)
  }

  const order = await orders.createOrder({
    merchant,
    zone,
    customerName: 'Client de test',
    customerPhone: '0000000000',
    deliveryAddress: '10 Avenue Alsace-Lorraine, 01000 Bourg-en-Bresse',
    deliveryLat: 46.21,
    deliveryLng: 5.23,
    pickupScheduledAt: { mode: 'scheduled', at: new Date('2030-01-01T11:00:00.000Z') },
    orderDetails: 'Deux sacs',
    deliveryInstructions: 'Sonnez',
    deliveryAddressComplement: 'Bâtiment B',
    cashOnDelivery
  })
  createdOrderIds.push(order.id)
  return order
}

async function createCashOnDeliveryOrder() {
  return createOrder({ amountCents: 5000 })
}

afterEach(async () => deleteTestOrders(pool, createdOrderIds.splice(0)))

describe('order lifecycle', () => {
  it('persists AVAILABLE -> ASSIGNED -> COLLECTED -> COMPLETED and transactional events', async () => {
    const available = await createOrder()

    expect(available.status).toBe('AVAILABLE')
    expect(available.version).toBe(1)
    expect(available.zoneId).toBe(zoneId)
    expect(available).toMatchObject({
      pickupScheduledAt: new Date('2030-01-01T11:00:00.000Z'),
      orderDetails: 'Deux sacs',
      deliveryInstructions: 'Sonnez',
      deliveryAddressComplement: 'Bâtiment B'
    })
    expect(available.priceCents).toBe(computePriceCents(available.distanceM, available.durationS))
    const persistedEarning = await pool.query<{ driver_earning_cents: number; price_cents: number }>(
      'select driver_earning_cents, price_cents from orders where id = $1',
      [available.id]
    )
    expect(persistedEarning.rows[0]).toEqual({
      driver_earning_cents: available.priceCents,
      price_cents: available.priceCents
    })
    expect(await transitionsFor(available.id)).toEqual([{ from_status: null, to_status: 'AVAILABLE' }])
    expect(await outboxFor(available.id)).toEqual([{ event_type: 'order.created.v1', aggregate_version: 1 }])

    const assigned = await orders.assignOrder({
      orderId: available.id,
      driverId,
      expectedVersion: available.version,
      actor: { type: 'driver', id: driverId }
    })
    expect(assigned.status).toBe('ASSIGNED')
    expect(assigned.version).toBe(2)
    expect((await orders.getDriverOrders(driverId)).find((order) => order.id === assigned.id)).toMatchObject({
      pickupScheduledAt: new Date('2030-01-01T11:00:00.000Z'),
      orderDetails: 'Deux sacs',
      deliveryInstructions: 'Sonnez',
      deliveryAddressComplement: 'Bâtiment B'
    })
    expect(await transitionsFor(available.id)).toContainEqual({ from_status: 'AVAILABLE', to_status: 'ASSIGNED' })
    expect(await outboxFor(available.id)).toContainEqual({ event_type: 'order.assigned.v1', aggregate_version: 2 })

    const collected = await orders.collectOrder({
      orderId: available.id,
      driverId,
      expectedVersion: assigned.version,
      actor: { type: 'driver', id: driverId }
    })
    expect(collected.status).toBe('COLLECTED')
    expect(collected.version).toBe(3)
    expect(await transitionsFor(available.id)).toContainEqual({ from_status: 'ASSIGNED', to_status: 'COLLECTED' })
    expect(await outboxFor(available.id)).toContainEqual({ event_type: 'order.collected.v1', aggregate_version: 3 })

    const completed = await orders.completeOrder({
      orderId: available.id,
      driverId,
      expectedVersion: collected.version,
      proof: { method: 'photo', imageBase64: proofPhotoBase64 },
      actor: { type: 'driver', id: driverId }
    })
    expect(completed.status).toBe('COMPLETED')
    expect(completed.version).toBe(4)
    expect(await transitionsFor(available.id)).toContainEqual({ from_status: 'COLLECTED', to_status: 'COMPLETED' })
    expect(await outboxFor(available.id)).toContainEqual({ event_type: 'order.completed.v1', aggregate_version: 4 })
    const proof = await pool.query<{ content_type: string; expires_at: Date }>(
      'select content_type, expires_at from order_proof_assets where order_id = $1',
      [available.id]
    )
    expect(proof.rows[0]).toMatchObject({ content_type: 'image/jpeg' })
    expect(proof.rows[0]?.expires_at.getTime()).toBeGreaterThan(Date.now())
  })

  it('persists RETURNING -> RETURNED with its transition and outbox events', async () => {
    const available = await createOrder()
    const assigned = await orders.assignOrder({
      orderId: available.id,
      driverId,
      expectedVersion: available.version,
      actor: { type: 'driver', id: driverId }
    })
    const collected = await orders.collectOrder({
      orderId: available.id,
      driverId,
      expectedVersion: assigned.version,
      actor: { type: 'driver', id: driverId }
    })

    await expect(orders.confirmReturn({
      orderId: collected.id,
      driverId,
      expectedVersion: collected.version,
      actor: { type: 'driver', id: driverId }
    })).rejects.toThrow('RETURNING -> RETURNED')

    const returning = await orders.returnOrder({
      orderId: collected.id,
      driverId,
      expectedVersion: collected.version,
      actor: { type: 'driver', id: driverId }
    })
    expect((await orders.getDriverOrders(driverId)).map(order => order.id)).toContain(returning.id)

    await expect(orders.confirmReturn({
      orderId: returning.id,
      driverId,
      expectedVersion: collected.version,
      actor: { type: 'driver', id: driverId }
    })).rejects.toThrow('RETURNING -> RETURNED')

    const returned = await orders.confirmReturn({
      orderId: returning.id,
      driverId,
      expectedVersion: returning.version,
      actor: { type: 'driver', id: driverId }
    })
    // available=1, assigned=2, collected=3, returning (COLLECTED->RETURNING)=4,
    // returned (RETURNING->RETURNED)=5 — chaque transition incrémente la
    // version d'exactement 1, comme partout ailleurs dans cette suite.
    expect(returned).toMatchObject({ status: 'RETURNED', version: 5 })
    expect(await transitionsFor(returned.id)).toContainEqual({ from_status: 'RETURNING', to_status: 'RETURNED' })
    expect(await outboxFor(returned.id)).toContainEqual({ event_type: 'order.returned.v1', aggregate_version: 5 })
  })

  it('keeps order events immutable', async () => {
    const available = await createOrder()
    const result = await pool.query<{ id: string }>(
      'select id from order_events where order_id = $1',
      [available.id]
    )
    const eventId = result.rows[0]?.id

    expect(eventId).toBeDefined()
    await expect(
      pool.query("update order_events set actor_type = 'system' where id = $1", [eventId])
    ).rejects.toThrow('order_events is an immutable append-only log')
    await expect(pool.query('delete from order_events where id = $1', [eventId])).rejects.toThrow(
      'order_events is an immutable append-only log'
    )
  })

  it('locks an invalid delivery code after three committed attempts without changing the order version', async () => {
    // bcrypt (12 rounds) run four times sequentially here; under parallel test
    // worker CPU contention this can exceed the default 5s timeout.
    const available = await createOrder()
    const assigned = await orders.assignOrder({
      orderId: available.id, driverId, expectedVersion: available.version, actor: { type: 'driver', id: driverId }
    })
    const collected = await orders.collectOrder({
      orderId: available.id, driverId, expectedVersion: assigned.version, actor: { type: 'driver', id: driverId }
    })
    const merchantOrder = (await orders.getMerchantOrders(merchantId)).find((order) => order.id === available.id)
    const invalidCode = merchantOrder?.deliveryCode === '0000' ? '0001' : '0000'

    for (const attemptsRemaining of [2, 1, 0]) {
      await expect(orders.completeOrder({
        orderId: available.id,
        driverId,
        expectedVersion: collected.version,
        proof: { method: 'code', code: invalidCode },
        actor: { type: 'driver', id: driverId }
      })).rejects.toMatchObject<Partial<DeliveryCodeInvalidError>>({ attemptsRemaining })
    }

    const persisted = await pool.query<{ version: number; delivery_code_failed_attempts: number; delivery_code_locked_at: Date | null }>(
      'select version, delivery_code_failed_attempts, delivery_code_locked_at from orders where id = $1', [available.id]
    )
    expect(persisted.rows[0]).toMatchObject({ version: collected.version, delivery_code_failed_attempts: 3 })
    expect(persisted.rows[0]?.delivery_code_locked_at).not.toBeNull()
    await expect(orders.completeOrder({
      orderId: available.id, driverId, expectedVersion: collected.version,
      proof: { method: 'code', code: invalidCode }, actor: { type: 'driver', id: driverId }
    })).rejects.toBeInstanceOf(DeliveryCodeLockedError)
  }, 15_000)

  it('rejects an expired delivery code', async () => {
    const available = await createOrder()
    const assigned = await orders.assignOrder({
      orderId: available.id, driverId, expectedVersion: available.version, actor: { type: 'driver', id: driverId }
    })
    const collected = await orders.collectOrder({
      orderId: available.id, driverId, expectedVersion: assigned.version, actor: { type: 'driver', id: driverId }
    })
    await pool.query('update orders set delivery_code_expires_at = now() - interval \'1 second\' where id = $1', [available.id])
    await expect(orders.completeOrder({
      orderId: available.id, driverId, expectedVersion: collected.version,
      proof: { method: 'code', code: '0000' }, actor: { type: 'driver', id: driverId }
    })).rejects.toBeInstanceOf(DeliveryCodeExpiredError)
  }, 15_000)

  it.each([
    { method: 'code' as const, code: '0000' },
    { method: 'signature' as const, imageBase64: 'iVBORw0KGgo=' },
    { method: 'photo' as const, imageBase64: proofPhotoBase64 }
  ])('rejects uncollected COD completion with proof %s before changing order', async proof => {
    const available = await createCashOnDeliveryOrder()
    const assigned = await orders.assignOrder({ orderId: available.id, driverId, expectedVersion: available.version, actor: { type: 'driver', id: driverId } })
    const collected = await orders.collectOrder({ orderId: available.id, driverId, expectedVersion: assigned.version, actor: { type: 'driver', id: driverId } })
    const merchantOrder = (await orders.getMerchantOrders(merchantId)).find(order => order.id === available.id)
    const submittedProof = proof.method === 'code'
      ? { ...proof, code: merchantOrder?.deliveryCode === '0000' ? '0001' : '0000' }
      : proof
    const before = await pool.query<{ version: number; delivery_code_failed_attempts: number; event_count: string; outbox_count: string }>(
      `select o.version, o.delivery_code_failed_attempts,
         (select count(*)::text from order_events where order_id = o.id) as event_count,
         (select count(*)::text from outbox_event where aggregate_id = o.id) as outbox_count
       from orders o where o.id = $1`, [available.id]
    )

    await expect(orders.completeOrder({ orderId: available.id, driverId, expectedVersion: collected.version, proof: submittedProof, actor: { type: 'driver', id: driverId } }))
      .rejects.toBeInstanceOf(CashOnDeliveryPaymentRequiredError)
    const after = await pool.query<{ status: string; version: number; delivery_code_failed_attempts: number; event_count: string; outbox_count: string }>(
      `select o.status, o.version, o.delivery_code_failed_attempts,
         (select count(*)::text from order_events where order_id = o.id) as event_count,
         (select count(*)::text from outbox_event where aggregate_id = o.id) as outbox_count
       from orders o where o.id = $1`, [available.id]
    )
    expect(after.rows[0]).toMatchObject({ status: 'COLLECTED', ...before.rows[0] })
  })

  it('completes collected COD with code and blocks a collected COD return', async () => {
    const available = await createCashOnDeliveryOrder()
    const assigned = await orders.assignOrder({ orderId: available.id, driverId, expectedVersion: available.version, actor: { type: 'driver', id: driverId } })
    const collected = await orders.collectOrder({ orderId: available.id, driverId, expectedVersion: assigned.version, actor: { type: 'driver', id: driverId } })
    const merchantOrder = (await orders.getMerchantOrders(merchantId)).find(order => order.id === available.id)
    await pool.query('update orders set cash_on_delivery_collected_at = now() where id = $1', [available.id])
    const completed = await orders.completeOrder({
      orderId: available.id, driverId, expectedVersion: collected.version,
      proof: { method: 'code', code: merchantOrder?.deliveryCode ?? '0000' }, actor: { type: 'driver', id: driverId }
    })
    expect(completed.status).toBe('COMPLETED')

    const returnable = await createCashOnDeliveryOrder()
    const returnAssigned = await orders.assignOrder({ orderId: returnable.id, driverId, expectedVersion: returnable.version, actor: { type: 'driver', id: driverId } })
    const returnCollected = await orders.collectOrder({ orderId: returnable.id, driverId, expectedVersion: returnAssigned.version, actor: { type: 'driver', id: driverId } })
    await pool.query('update orders set cash_on_delivery_collected_at = now() where id = $1', [returnable.id])
    await expect(orders.returnOrder({ orderId: returnable.id, driverId, expectedVersion: returnCollected.version, actor: { type: 'driver', id: driverId } }))
      .rejects.toBeInstanceOf(CashOnDeliveryAlreadyCollectedError)
  })

  it('allows return of uncollected COD', async () => {
    const available = await createCashOnDeliveryOrder()
    const assigned = await orders.assignOrder({ orderId: available.id, driverId, expectedVersion: available.version, actor: { type: 'driver', id: driverId } })
    const collected = await orders.collectOrder({ orderId: available.id, driverId, expectedVersion: assigned.version, actor: { type: 'driver', id: driverId } })
    await expect(orders.returnOrder({ orderId: available.id, driverId, expectedVersion: collected.version, actor: { type: 'driver', id: driverId } }))
      .resolves.toMatchObject({ status: 'RETURNING' })
  })

  it('keeps COD guards hidden from another driver and stale versions', async () => {
    const available = await createCashOnDeliveryOrder()
    const assigned = await orders.assignOrder({ orderId: available.id, driverId, expectedVersion: available.version, actor: { type: 'driver', id: driverId } })
    const collected = await orders.collectOrder({ orderId: available.id, driverId, expectedVersion: assigned.version, actor: { type: 'driver', id: driverId } })

    await expect(orders.completeOrder({
      orderId: available.id, driverId: otherDriverId, expectedVersion: collected.version,
      proof: { method: 'code', code: '0000' }, actor: { type: 'driver', id: otherDriverId }
    })).rejects.toBeInstanceOf(OrderConflictError)
    await expect(orders.completeOrder({
      orderId: available.id, driverId, expectedVersion: collected.version + 1,
      proof: { method: 'code', code: '0000' }, actor: { type: 'driver', id: driverId }
    })).rejects.toBeInstanceOf(OrderConflictError)
    await expect(orders.returnOrder({
      orderId: available.id, driverId: otherDriverId, expectedVersion: collected.version, actor: { type: 'driver', id: otherDriverId }
    })).rejects.toBeInstanceOf(OrderConflictError)
    await expect(orders.returnOrder({
      orderId: available.id, driverId, expectedVersion: collected.version + 1, actor: { type: 'driver', id: driverId }
    })).rejects.toBeInstanceOf(OrderConflictError)

    const persisted = await pool.query<{ status: string; version: number; delivery_code_failed_attempts: number }>(
      'select status, version, delivery_code_failed_attempts from orders where id = $1', [available.id]
    )
    expect(persisted.rows[0]).toEqual({ status: 'COLLECTED', version: collected.version, delivery_code_failed_attempts: 0 })
  })

  it('verifies COD delivery code without consuming it or transitioning the order', async () => {
    const available = await createCashOnDeliveryOrder()
    const assigned = await orders.assignOrder({ orderId: available.id, driverId, expectedVersion: available.version, actor: { type: 'driver', id: driverId } })
    const collected = await orders.collectOrder({ orderId: available.id, driverId, expectedVersion: assigned.version, actor: { type: 'driver', id: driverId } })
    const merchantOrder = (await orders.getMerchantOrders(merchantId)).find(order => order.id === available.id)
    const before = await pool.query<{
      status: string
      version: number
      delivery_code_hash: string
      delivery_code_failed_attempts: number
      event_count: string
      outbox_count: string
    }>(
      `select o.status, o.version, o.delivery_code_hash, o.delivery_code_failed_attempts,
         (select count(*)::text from order_events where order_id = o.id) as event_count,
         (select count(*)::text from outbox_event where aggregate_id = o.id) as outbox_count
       from orders o where o.id = $1`,
      [available.id]
    )

    await expect(orders.verifyDeliveryCodeForCompletion({
      orderId: available.id, driverId, expectedVersion: collected.version, code: merchantOrder?.deliveryCode ?? '0000'
    })).resolves.toEqual({ verified: true })

    const after = await pool.query<{
      status: string
      version: number
      delivery_code_hash: string
      delivery_code_failed_attempts: number
      event_count: string
      outbox_count: string
    }>(
      `select o.status, o.version, o.delivery_code_hash, o.delivery_code_failed_attempts,
         (select count(*)::text from order_events where order_id = o.id) as event_count,
         (select count(*)::text from outbox_event where aggregate_id = o.id) as outbox_count
       from orders o where o.id = $1`,
      [available.id]
    )
    expect(after.rows[0]).toEqual(before.rows[0])

    const returning = await orders.returnOrder({
      orderId: available.id, driverId, expectedVersion: collected.version, actor: { type: 'driver', id: driverId }
    })
    await expect(orders.verifyDeliveryCodeForCompletion({
      orderId: available.id, driverId, expectedVersion: returning.version, code: '0000'
    })).rejects.toBeInstanceOf(OrderConflictError)
    const failedAttempts = await pool.query<{ delivery_code_failed_attempts: number }>(
      'select delivery_code_failed_attempts from orders where id = $1', [available.id]
    )
    expect(failedAttempts.rows[0]).toEqual({ delivery_code_failed_attempts: 0 })
  }, 15_000)

  it('commits COD code failures and hides completion guards before checking the code', async () => {
    const available = await createCashOnDeliveryOrder()
    const assigned = await orders.assignOrder({ orderId: available.id, driverId, expectedVersion: available.version, actor: { type: 'driver', id: driverId } })
    const collected = await orders.collectOrder({ orderId: available.id, driverId, expectedVersion: assigned.version, actor: { type: 'driver', id: driverId } })
    const merchantOrder = (await orders.getMerchantOrders(merchantId)).find(order => order.id === available.id)
    const invalidCode = merchantOrder?.deliveryCode === '0000' ? '0001' : '0000'

    for (const attemptsRemaining of [2, 1, 0]) {
      await expect(orders.verifyDeliveryCodeForCompletion({
        orderId: available.id, driverId, expectedVersion: collected.version, code: invalidCode
      })).rejects.toMatchObject<Partial<DeliveryCodeInvalidError>>({ attemptsRemaining })
    }
    await expect(orders.verifyDeliveryCodeForCompletion({
      orderId: available.id, driverId, expectedVersion: collected.version, code: invalidCode
    })).rejects.toBeInstanceOf(DeliveryCodeLockedError)

    await pool.query('update orders set delivery_code_expires_at = now() - interval \'1 second\' where id = $1', [available.id])
    await expect(orders.verifyDeliveryCodeForCompletion({
      orderId: available.id, driverId, expectedVersion: collected.version, code: invalidCode
    })).rejects.toBeInstanceOf(DeliveryCodeExpiredError)

    await expect(orders.verifyDeliveryCodeForCompletion({
      orderId: available.id, driverId: otherDriverId, expectedVersion: collected.version, code: invalidCode
    })).rejects.toBeInstanceOf(OrderConflictError)
    await expect(orders.verifyDeliveryCodeForCompletion({
      orderId: available.id, driverId, expectedVersion: collected.version + 1, code: invalidCode
    })).rejects.toBeInstanceOf(OrderConflictError)
    const persisted = await pool.query<{ delivery_code_failed_attempts: number }>(
      'select delivery_code_failed_attempts from orders where id = $1', [available.id]
    )
    expect(persisted.rows[0]).toEqual({ delivery_code_failed_attempts: 3 })
  }, 25_000)

  it('completes COD in caller transaction and rolls it back atomically', async () => {
    const available = await createCashOnDeliveryOrder()
    const assigned = await orders.assignOrder({ orderId: available.id, driverId, expectedVersion: available.version, actor: { type: 'driver', id: driverId } })
    const collected = await orders.collectOrder({ orderId: available.id, driverId, expectedVersion: assigned.version, actor: { type: 'driver', id: driverId } })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const completed = await orders.completeCollectedCashOnDeliveryInTransaction(client, {
        orderId: available.id, driverId, expectedVersion: collected.version,
        actor: { type: 'system' }, correlationId: randomUUID()
      })
      expect(completed).toMatchObject({ status: 'COMPLETED', version: collected.version + 1, deliveryProofMethod: 'code' })
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    const rolledBack = await pool.query<{ status: string; version: number; collected_at: Date | null; completed_at: Date | null; event_count: string; outbox_count: string }>(
      `select o.status, o.version, o.cash_on_delivery_collected_at as collected_at, o.completed_at,
         (select count(*)::text from order_events where order_id = o.id) as event_count,
         (select count(*)::text from outbox_event where aggregate_id = o.id) as outbox_count
       from orders o where o.id = $1`, [available.id]
    )
    expect(rolledBack.rows[0]).toMatchObject({ status: 'COLLECTED', version: collected.version, collected_at: null, completed_at: null, event_count: '3', outbox_count: '3' })

    const committedClient = await pool.connect()
    try {
      await committedClient.query('BEGIN')
      await orders.completeCollectedCashOnDeliveryInTransaction(committedClient, {
        orderId: available.id, driverId, expectedVersion: collected.version,
        actor: { type: 'system' }, correlationId: randomUUID()
      })
      await committedClient.query('COMMIT')
    } finally {
      committedClient.release()
    }
    const persisted = await pool.query<{ status: string; version: number; collected_at: Date | null; completed_at: Date | null }>(
      'select status, version, cash_on_delivery_collected_at as collected_at, completed_at from orders where id = $1', [available.id]
    )
    expect(persisted.rows[0]).toMatchObject({ status: 'COMPLETED', version: collected.version + 1 })
    expect(persisted.rows[0]?.collected_at).not.toBeNull()
    expect(persisted.rows[0]?.completed_at).not.toBeNull()
    expect(await transitionsFor(available.id)).toContainEqual({ from_status: 'COLLECTED', to_status: 'COMPLETED' })
    expect(await outboxFor(available.id)).toContainEqual({ event_type: 'order.completed.v1', aggregate_version: collected.version + 1 })
    const retryClient = await pool.connect()
    try {
      await retryClient.query('BEGIN')
      await expect(orders.completeCollectedCashOnDeliveryInTransaction(retryClient, {
        orderId: available.id, driverId, expectedVersion: collected.version,
        actor: { type: 'system' }, correlationId: randomUUID()
      })).rejects.toBeInstanceOf(OrderConflictError)
      await retryClient.query('ROLLBACK')
    } finally {
      retryClient.release()
    }
  })

  it('rejects COD participant guards without persisting a transition', async () => {
    const available = await createCashOnDeliveryOrder()
    const assigned = await orders.assignOrder({ orderId: available.id, driverId, expectedVersion: available.version, actor: { type: 'driver', id: driverId } })
    const collected = await orders.collectOrder({ orderId: available.id, driverId, expectedVersion: assigned.version, actor: { type: 'driver', id: driverId } })
    const nonCod = await createOrder()
    const nonCodAssigned = await orders.assignOrder({ orderId: nonCod.id, driverId, expectedVersion: nonCod.version, actor: { type: 'driver', id: driverId } })
    const nonCodCollected = await orders.collectOrder({ orderId: nonCod.id, driverId, expectedVersion: nonCodAssigned.version, actor: { type: 'driver', id: driverId } })
    const returning = await orders.returnOrder({ orderId: available.id, driverId, expectedVersion: collected.version, actor: { type: 'driver', id: driverId } })

    for (const command of [
      { orderId: collected.id, driverId: otherDriverId, expectedVersion: collected.version },
      { orderId: collected.id, driverId, expectedVersion: collected.version + 1 },
      { orderId: returning.id, driverId, expectedVersion: returning.version },
      { orderId: nonCodCollected.id, driverId, expectedVersion: nonCodCollected.version }
    ]) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const expected = command.orderId === nonCodCollected.id ? CashOnDeliveryNotRequiredError : OrderConflictError
        await expect(orders.completeCollectedCashOnDeliveryInTransaction(client, {
          ...command, actor: { type: 'system' }, correlationId: 'cod-completion-guard-test'
        })).rejects.toBeInstanceOf(expected)
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }
    }
    const persisted = await pool.query<{ id: string; status: string; version: number }>(
      'select id, status, version from orders where id = any($1::uuid[])', [[returning.id, nonCodCollected.id]]
    )
    expect(persisted.rows).toEqual(expect.arrayContaining([
      { id: returning.id, status: 'RETURNING', version: returning.version },
      { id: nonCodCollected.id, status: 'COLLECTED', version: nonCodCollected.version }
    ]))
  })
})
