import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { PG_FOREIGN_KEY_VIOLATION, pgErrorCode } from '../../../platform/pg-error.js'
import { inTransaction } from '../../../platform/transaction.js'
import { InvalidZoneAssignmentError, OrderConflictError } from '../domain/errors.js'
import {
  buildOrderAssignedEvent,
  buildOrderCollectedEvent,
  buildOrderCompletedEvent,
  buildOrderCreatedEvent,
  buildOrderReturnedEvent,
  buildOrderReturningEvent,
  type DomainEvent
} from '../domain/order-events.js'
import type { Actor, AvailableOrder, DeliveryProofMethod, DriverHistoryOrder, DriverOrder, MerchantOrder, MerchantProofAsset, Order } from '../domain/order.js'
import type { DriverCompletedOrderEarning, DriverEarnings } from '../domain/driver-earnings.js'
import {
  DeliveryCodeExpiredError,
  DeliveryCodeInvalidError,
  DeliveryCodeLockedError,
  generateDeliveryCode,
  verifyDeliveryCode
} from '../domain/delivery-code.js'
import type { OrderEvent } from '../domain/order-event.js'
import type { OrderStatus } from '../domain/order-status.js'
import type { ProofOfDeliveryAsset } from '../domain/proof-of-delivery.js'
import type { CreateOrderInput, OrderRepository } from '../ports/order-repository.js'
import type { OrderTrackingRecord } from '../ports/order-tracking-repository.js'
import { GROUPAGE_WINDOW_MINUTES } from '../domain/dispatch.js'

type OrderRow = {
  id: string
  merchant_id: string
  driver_id: string | null
  zone_id: string
  status: OrderStatus
  version: number
  customer_name: string
  customer_phone: string
  customer_email: string | null
  pickup_scheduled_at: Date | null
  order_details: string | null
  delivery_instructions: string | null
  delivery_address_complement: string | null
  pickup_address: string
  pickup_lat: number
  pickup_lng: number
  delivery_address: string
  delivery_lat: number
  delivery_lng: number
  distance_m: number
  duration_s: number
  price_cents: number
  delivery_proof_method: DeliveryProofMethod | null
  driver_earning_cents: number
  assigned_at: Date | null
  collected_at: Date | null
  completed_at: Date | null
  delivery_code_hash: string | null
  delivery_code_plain: string | null
  delivery_code_generated_at: Date | null
  delivery_code_expires_at: Date | null
  delivery_code_failed_attempts: number
  delivery_code_locked_at: Date | null
  created_at: Date
  updated_at: Date
  metadata?: {
    dispatch_failed?: unknown
  }
}

type MerchantOrderRow = OrderRow & {
  tracking_token: string
  driver_name: string | null
  driver_phone: string | null
}

type MerchantProofAssetRow = {
  order_id: string
  kind: Exclude<DeliveryProofMethod, 'code'>
  content: Buffer
  content_type: MerchantProofAsset['contentType']
  created_at: Date
}

type DriverOrderRow = Omit<
  OrderRow,
  | 'customer_name'
  | 'customer_phone'
  | 'delivery_code_hash'
  | 'delivery_code_plain'
  | 'delivery_code_generated_at'
  | 'delivery_code_expires_at'
  | 'delivery_code_failed_attempts'
  | 'delivery_code_locked_at'
> & {
  customer_name: string | null
  customer_phone: string | null
  merchant_name: string
  merchant_phone: string | null
}

type OrderEventRow = {
  id: string
  order_id: string
  from_status: OrderStatus | null
  to_status: OrderStatus
  actor_type: OrderEvent['actorType']
  actor_id: string | null
  created_at: Date
}

type DriverEarningsSummaryRow = {
  total_earning_cents: string
  completed_order_count: string
}

type DriverCompletedOrderEarningRow = {
  id: string
  completed_at: Date
  driver_earning_cents: number
  delivery_address: string
}

function mapOrder(row: OrderRow): Order {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    driverId: row.driver_id,
    zoneId: row.zone_id,
    status: row.status,
    version: row.version,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerEmail: row.customer_email,
    pickupScheduledAt: row.pickup_scheduled_at,
    orderDetails: row.order_details,
    deliveryInstructions: row.delivery_instructions,
    deliveryAddressComplement: row.delivery_address_complement,
    pickupAddress: row.pickup_address,
    pickupLat: row.pickup_lat,
    pickupLng: row.pickup_lng,
    deliveryAddress: row.delivery_address,
    deliveryLat: row.delivery_lat,
    deliveryLng: row.delivery_lng,
    distanceM: row.distance_m,
    durationS: row.duration_s,
    priceCents: row.price_cents,
    deliveryProofMethod: row.delivery_proof_method,
    assignedAt: row.assigned_at,
    collectedAt: row.collected_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapDriverOrder(row: DriverOrderRow): DriverOrder {
  return {
    ...mapOrder({
      ...row,
      // The canonical domain model is only used internally and requires these
      // fields. They are overwritten below by the driver-safe nullable values.
      customer_name: row.customer_name ?? '',
      customer_phone: row.customer_phone ?? '',
      delivery_code_hash: null,
      delivery_code_plain: null,
      delivery_code_generated_at: null,
      delivery_code_expires_at: null,
      delivery_code_failed_attempts: 0,
      delivery_code_locked_at: null
    }),
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    merchantName: row.merchant_name,
    merchantPhone: row.merchant_phone
  }
}

function mapDriverHistoryOrder(row: DriverOrderRow): DriverHistoryOrder {
  return { ...mapDriverOrder(row), driverEarningCents: row.driver_earning_cents }
}

const driverOrderSelect = `
  select
    o.id, o.merchant_id, o.driver_id, o.zone_id, o.status, o.version,
    case when o.status in ('COLLECTED', 'RETURNING', 'RETURNED', 'COMPLETED')
      then o.customer_name else null end as customer_name,
    case when o.status in ('COLLECTED', 'RETURNING', 'RETURNED', 'COMPLETED')
      then o.customer_phone else null end as customer_phone,
    o.customer_email, o.pickup_scheduled_at, o.order_details,
    o.delivery_instructions, o.delivery_address_complement,
    o.pickup_address, o.pickup_lat, o.pickup_lng,
    o.delivery_address, o.delivery_lat, o.delivery_lng,
    o.distance_m, o.duration_s, o.price_cents, o.delivery_proof_method, o.driver_earning_cents,
    o.assigned_at, o.collected_at, o.completed_at, o.created_at, o.updated_at,
    m.name as merchant_name, coalesce(m.phone_landline, m.phone_mobile) as merchant_phone
  from orders o
  join merchants m on m.id = o.merchant_id`

function mapMerchantOrder(
  row: MerchantOrderRow,
  events: OrderEvent[],
  proofAsset: MerchantProofAsset | null
): MerchantOrder {
  const order: MerchantOrder = {
    ...mapOrder(row),
    trackingToken: row.tracking_token,
    events,
    driverName: row.driver_name,
    driverPhone: row.driver_phone,
    proofAsset,
    dispatchFailed: row.metadata?.dispatch_failed === true
  }
  // TODO: TWILIO — temporary plaintext display for the owning merchant only.
  // Never expose the bcrypt hash, and never compare this value for verification.
  if (row.status === 'COLLECTED' && row.delivery_code_plain !== null) {
    order.deliveryCode = row.delivery_code_plain
  }
  return order
}

function mapOrderEvent(row: OrderEventRow): OrderEvent {
  return {
    id: row.id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actorType: row.actor_type,
    actorId: row.actor_id,
    createdAt: row.created_at
  }
}

function constraintName(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'constraint' in error) {
    const { constraint } = error
    return typeof constraint === 'string' ? constraint : undefined
  }

  return undefined
}

function isZoneForeignKeyViolation(error: unknown, constraint: string): boolean {
  return pgErrorCode(error) === PG_FOREIGN_KEY_VIOLATION && constraintName(error) === constraint
}

async function insertTransitionEvent(
  client: PoolClient,
  order: Order,
  fromStatus: OrderStatus | null,
  actor: Actor,
  correlationId: string,
  event: DomainEvent
): Promise<void> {
  await client.query(
    `insert into order_events (order_id, from_status, to_status, actor_type, actor_id, correlation_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [order.id, fromStatus, order.status, actor.type, actor.id ?? null, correlationId]
  )
  await client.query(
    `insert into outbox_event
       (event_type, event_version, aggregate_type, aggregate_id, aggregate_version, payload, correlation_id)
     values ($1, $2, 'order', $3, $4, $5, $6)`,
    [
      event.eventType,
      event.eventVersion,
      order.id,
      event.aggregateVersion,
      event.payload,
      correlationId
    ]
  )
}

export class PostgresOrderRepository implements OrderRepository {
  public constructor(private readonly pool: Pool) {}

  public async create(input: CreateOrderInput): Promise<Order> {
    try {
      return await inTransaction(this.pool, async (client) => {
        const result = await client.query<OrderRow>(
          `insert into orders (
             merchant_id, zone_id, customer_name, customer_phone, customer_email, pickup_scheduled_at,
             order_details, delivery_instructions, delivery_address_complement, status,
             pickup_address, pickup_lat, pickup_lng, delivery_address, delivery_lat, delivery_lng,
             distance_m, duration_s, driver_earning_cents
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'AVAILABLE', $10, $11, $12, $13, $14, $15, $16, $17, 0)
           returning *`,
          [
            input.merchantId,
            input.zoneId,
            input.customerName,
            input.customerPhone,
            input.customerEmail,
            input.pickupScheduledAt,
            input.orderDetails,
            input.deliveryInstructions,
            input.deliveryAddressComplement,
            input.pickupAddress,
            input.pickupLat,
            input.pickupLng,
            input.deliveryAddress,
            input.deliveryLat,
            input.deliveryLng,
            input.distanceM,
            input.durationS
          ]
        )
        const row = result.rows[0]
        if (row === undefined) {
          throw new Error('Order insert did not return a row')
        }
        // price_cents is generated by Postgres. Copy that persisted value rather
        // than duplicating the pricing formula in application code.
        const earningResult = await client.query<OrderRow>(
          `update orders set driver_earning_cents = $1 where id = $2 returning *`,
          [row.price_cents, row.id]
        )
        const earningRow = earningResult.rows[0]
        if (earningRow === undefined) {
          throw new Error('Order earning update did not return a row')
        }
        const order = mapOrder(earningRow)
        await insertTransitionEvent(
          client,
          order,
          null,
          input.actor,
          input.correlationId,
          buildOrderCreatedEvent(order)
        )
        return order
      })
    } catch (error) {
      if (isZoneForeignKeyViolation(error, 'orders_merchant_zone_fk')) {
        throw new InvalidZoneAssignmentError(
          `Merchant ${input.merchantId} does not belong to zone ${input.zoneId}`
        )
      }
      throw error
    }
  }

  public async findById(orderId: string): Promise<Order | null> {
    const result = await this.pool.query<OrderRow>('select * from orders where id = $1', [orderId])
    const row = result.rows[0]
    return row === undefined ? null : mapOrder(row)
  }

  public async findDispatchMetadata(orderId: string): Promise<import('../domain/dispatch.js').DispatchMetadata | null> {
    const result = await this.pool.query<{ metadata: { dispatch_attempts?: unknown; dispatch_radius_km?: unknown; dispatch_failed?: unknown } }>(
      'select metadata from orders where id = $1', [orderId]
    )
    const row = result.rows[0]
    if (row === undefined) return null
    const attempts = Array.isArray(row.metadata.dispatch_attempts) ? row.metadata.dispatch_attempts : []
    return {
      dispatchAttempts: attempts.filter((attempt): attempt is import('../domain/dispatch.js').DispatchAttempt =>
        typeof attempt === 'object' && attempt !== null &&
        typeof (attempt as { driverId?: unknown }).driverId === 'string' &&
        ((attempt as { reason?: unknown }).reason === 'refused' || (attempt as { reason?: unknown }).reason === 'timeout') &&
        typeof (attempt as { round?: unknown }).round === 'number' &&
        typeof (attempt as { refusedAt?: unknown }).refusedAt === 'string'
      ),
      dispatchRadiusKm: typeof row.metadata.dispatch_radius_km === 'number' ? row.metadata.dispatch_radius_km : null,
      dispatchFailed: row.metadata.dispatch_failed === true
    }
  }

  public async findStuckAvailableOrders(olderThanMinutes: number): Promise<{ orderId: string; merchantId: string }[]> {
    const result = await this.pool.query<{ order_id: string; merchant_id: string }>(
      `select o.id as order_id, o.merchant_id
       from orders o
       where o.status = 'AVAILABLE' and o.driver_id is null
         and o.updated_at <= now() - ($1::text || ' minutes')::interval
         and coalesce((o.metadata->>'dispatch_failed')::boolean, false) = false`,
      [olderThanMinutes]
    )
    return result.rows.map((row) => ({ orderId: row.order_id, merchantId: row.merchant_id }))
  }

  public async findTrackingByToken(token: string): Promise<OrderTrackingRecord | null> {
    const result = await this.pool.query<{
      status: OrderStatus
      assigned_at: Date | null
      collected_at: Date | null
      completed_at: Date | null
      duration_s: number
      lat: number | null
      lng: number | null
    }>(
      `select o.status, o.assigned_at, o.collected_at, o.completed_at, o.duration_s, location.lat, location.lng
       from orders o
       left join lateral (
         select lat, lng from driver_locations
         where driver_id = o.driver_id
         order by recorded_at desc, id desc
         limit 1
       ) location on o.status in ('ASSIGNED', 'COLLECTED')
       where o.tracking_token = $1`,
      [token]
    )
    const row = result.rows[0]
    if (row === undefined) return null
    return {
      status: row.status,
      assignedAt: row.assigned_at,
      collectedAt: row.collected_at,
      completedAt: row.completed_at,
      durationS: row.duration_s,
      driverPosition: row.lat === null || row.lng === null ? null : { lat: row.lat, lng: row.lng }
    }
  }

  public async findActiveTrackingTokensByDriverId(driverId: string): Promise<readonly string[]> {
    const result = await this.pool.query<{ tracking_token: string }>(
      `select tracking_token from orders
       where driver_id = $1 and status in ('ASSIGNED', 'COLLECTED')`,
      [driverId]
    )
    return result.rows.map((row) => row.tracking_token)
  }

  public async findByMerchantId(merchantId: string): Promise<MerchantOrder[]> {
    const ordersResult = await this.pool.query<MerchantOrderRow>(
      `select o.*, d.name as driver_name, d.phone as driver_phone
       from orders o
       left join drivers d on d.id = o.driver_id
       where o.merchant_id = $1
       order by o.created_at desc`,
      [merchantId]
    )
    const orders = ordersResult.rows.map(mapOrder)
    if (orders.length === 0) {
      return []
    }

    const orderIds = orders.map((order) => order.id)
    const [eventsResult, proofsResult] = await Promise.all([
      this.pool.query<OrderEventRow>(
        'select * from order_events where order_id = any($1) order by created_at asc, id asc',
        [orderIds]
      ),
      this.pool.query<MerchantProofAssetRow>(
        `select order_id, kind, content, content_type, created_at
         from order_proof_assets
         where order_id = any($1) and expires_at > now()`,
        [orderIds]
      )
    ])
    const eventsByOrderId = new Map<string, OrderEvent[]>()
    for (const row of eventsResult.rows) {
      const events = eventsByOrderId.get(row.order_id)
      const event = mapOrderEvent(row)
      if (events === undefined) {
        eventsByOrderId.set(row.order_id, [event])
      } else {
        events.push(event)
      }
    }

    const proofsByOrderId = new Map<string, MerchantProofAsset>()
    for (const proof of proofsResult.rows) {
      proofsByOrderId.set(proof.order_id, {
        kind: proof.kind,
        contentBase64: proof.content.toString('base64'),
        contentType: proof.content_type,
        createdAt: proof.created_at
      })
    }

    return ordersResult.rows.map((row) =>
      mapMerchantOrder(row, eventsByOrderId.get(row.id) ?? [], proofsByOrderId.get(row.id) ?? null)
    )
  }

  public async findAvailableInZone(zoneId: string): Promise<AvailableOrder[]> {
    const result = await this.pool.query<DriverOrderRow>(
      `${driverOrderSelect}
       where o.zone_id = $1 and o.status = 'AVAILABLE' and o.driver_id is null
       order by o.created_at`,
      [zoneId]
    )
    return result.rows.map(mapDriverOrder)
  }

  public async findDriverOrderById(orderId: string): Promise<DriverOrder | null> {
    const result = await this.pool.query<DriverOrderRow>(
      `${driverOrderSelect}
       where o.id = $1`,
      [orderId]
    )
    const row = result.rows[0]
    return row === undefined ? null : mapDriverOrder(row)
  }

  public async findDriversWithActiveOrderForMerchant(
    merchantId: string,
    targetPickupAt: Date
  ): Promise<{ driverId: string; orderId: string; pickupScheduledAt: Date | null }[]> {
    const result = await this.pool.query<{
      driver_id: string
      order_id: string
      pickup_scheduled_at: Date | null
    }>(
      `select driver_id, id as order_id, pickup_scheduled_at
       from orders
       where merchant_id = $1
         and driver_id is not null
         and status in ('ASSIGNED', 'COLLECTED')
         and pickup_scheduled_at is not null
         and abs(extract(epoch from (pickup_scheduled_at - $2::timestamptz))) < $3 * 60`,
      [merchantId, targetPickupAt, GROUPAGE_WINDOW_MINUTES]
    )
    return result.rows.map((row) => ({
      driverId: row.driver_id,
      orderId: row.order_id,
      pickupScheduledAt: row.pickup_scheduled_at
    }))
  }

  public async recordDispatchAttempt(
    orderId: string,
    attempt: { driverId: string; reason: 'refused' | 'timeout'; round: number; refusedAt: Date },
    expectedVersion: number
  ): Promise<Order> {
    const result = await this.pool.query<OrderRow>(
      `update orders
       set metadata = jsonb_set(
             metadata,
             '{dispatch_attempts}',
             coalesce(metadata->'dispatch_attempts', '[]'::jsonb) || jsonb_build_array(
               jsonb_build_object(
                 'driverId', $2,
                 'reason', $3,
                 'round', $4,
                 'refusedAt', $5::timestamptz
               )
             ),
             true
           ),
           version = version + 1,
           updated_at = now()
       where id = $1 and version = $6
       returning *`,
      [orderId, attempt.driverId, attempt.reason, attempt.round, attempt.refusedAt, expectedVersion]
    )
    if (result.rowCount !== 1 || result.rows[0] === undefined) {
      throw new OrderConflictError(`Order ${orderId} dispatch metadata could not be updated`)
    }
    return mapOrder(result.rows[0])
  }

  public async markDispatchFailed(orderId: string, expectedVersion: number): Promise<Order> {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query<OrderRow>(
        `update orders
         set metadata = jsonb_set(metadata, '{dispatch_failed}', 'true'::jsonb, true),
             version = version + 1,
             updated_at = now()
         where id = $1 and version = $2
         returning *`,
        [orderId, expectedVersion]
      )
      const row = result.rows[0]
      if (result.rowCount !== 1 || row === undefined) {
        throw new OrderConflictError(`Order ${orderId} dispatch failure could not be recorded`)
      }
      await client.query(
        `insert into outbox_event (event_type, aggregate_type, aggregate_id, aggregate_version, payload, correlation_id)
         values ('order.dispatch_failed.v1', 'order', $1, $2, $3::jsonb, $4)`,
        [row.id, row.version, JSON.stringify({ orderId: row.id, merchantId: row.merchant_id }), randomUUID()]
      )
      return mapOrder(row)
    })
  }

  public async findActiveByDriverId(driverId: string): Promise<DriverOrder[]> {
    const result = await this.pool.query<DriverOrderRow>(
      `${driverOrderSelect}
       where o.driver_id = $1 and o.status in ('ASSIGNED', 'COLLECTED', 'RETURNING')
       order by assigned_at asc, created_at asc`,
      [driverId]
    )
    return result.rows.map(mapDriverOrder)
  }

  public async findHistoryByDriverId(driverId: string): Promise<DriverHistoryOrder[]> {
    const result = await this.pool.query<DriverOrderRow>(
      `${driverOrderSelect}
       where o.driver_id = $1 and o.status in ('COMPLETED', 'RETURNED', 'CANCELLED')
       order by o.updated_at desc
       limit 30`,
      [driverId]
    )
    return result.rows.map(mapDriverHistoryOrder)
  }

  public async getDriverEarnings(driverId: string): Promise<DriverEarnings> {
    const [summaryResult, recentOrdersResult] = await Promise.all([
      this.pool.query<DriverEarningsSummaryRow>(
        `select coalesce(sum(driver_earning_cents), 0)::text as total_earning_cents,
                count(*)::text as completed_order_count
         from orders
         where driver_id = $1 and status = 'COMPLETED'`,
        [driverId]
      ),
      this.pool.query<DriverCompletedOrderEarningRow>(
        `select id, completed_at, driver_earning_cents, delivery_address
         from orders
         where driver_id = $1 and status = 'COMPLETED'
         order by completed_at desc
         limit 20`,
        [driverId]
      )
    ])
    const summary = summaryResult.rows[0]
    if (summary === undefined) {
      throw new Error('Driver earnings aggregation did not return a row')
    }

    return {
      totalEarningCents: Number(summary.total_earning_cents),
      completedOrderCount: Number(summary.completed_order_count),
      currency: 'EUR',
      paymentMethod: 'bank_transfer',
      paymentStatus: 'provisional',
      recentCompletedOrders: recentOrdersResult.rows.map((row): DriverCompletedOrderEarning => ({
        id: row.id,
        completedAt: row.completed_at,
        earningCents: row.driver_earning_cents,
        deliveryAddress: row.delivery_address
      }))
    }
  }

  public async assign(
    orderId: string,
    driverId: string,
    expectedVersion: number,
    actor: Actor,
    correlationId: string
  ): Promise<Order> {
    try {
      return await inTransaction(this.pool, async (client) => {
        const result = await client.query<OrderRow>(
          `update orders
           set driver_id = $1, status = 'ASSIGNED', assigned_at = now(), updated_at = now(), version = version + 1
           where id = $2 and status = 'AVAILABLE' and driver_id is null and version = $3
           returning *`,
          [driverId, orderId, expectedVersion]
        )
        if (result.rowCount !== 1 || result.rows[0] === undefined) {
          throw new OrderConflictError(`Order ${orderId} could not transition AVAILABLE -> ASSIGNED`)
        }
        const order = mapOrder(result.rows[0])
        await insertTransitionEvent(
          client,
          order,
          'AVAILABLE',
          actor,
          correlationId,
          buildOrderAssignedEvent(order)
        )
        return order
      })
    } catch (error) {
      if (isZoneForeignKeyViolation(error, 'orders_driver_zone_fk')) {
        throw new InvalidZoneAssignmentError(`Driver ${driverId} does not belong to the zone of order ${orderId}`)
      }
      throw error
    }
  }

  public async collect(
    orderId: string,
    driverId: string,
    expectedVersion: number,
    actor: Actor,
    correlationId: string
  ): Promise<Order> {
    // Calculé AVANT l'ouverture de la transaction : bcrypt.hash (CPU-bound,
    // pur JS via bcryptjs) peut dépasser 5s sous forte contention CPU
    // (plusieurs workers de test en parallèle notamment), ce qui déclenchait
    // le idle_in_transaction_session_timeout de Postgres (5s, voir
    // platform/db.ts) et faisait échouer la transaction avec une erreur de
    // connexion au lieu du conflit métier attendu. Aucun travail CPU lourd ne
    // doit rester dans la fenêtre transactionnelle.
    // TODO: TWILIO — `plain` is temporary merchant-display data. The bcrypt
    // hash generated here is the sole source of truth for verification.
    const deliveryCode = await generateDeliveryCode()
    return inTransaction(this.pool, async (client) => {
      const result = await client.query<OrderRow>(
        `update orders
         set status = 'COLLECTED', collected_at = now(), updated_at = now(), version = version + 1,
             delivery_code_hash = $4, delivery_code_plain = $5,
             delivery_code_generated_at = $6, delivery_code_expires_at = $7,
             delivery_code_failed_attempts = 0, delivery_code_locked_at = null
         where id = $1 and driver_id = $2 and status = 'ASSIGNED' and version = $3
         returning *`,
        [orderId, driverId, expectedVersion, deliveryCode.hash, deliveryCode.plain, deliveryCode.generatedAt, deliveryCode.expiresAt]
      )
      if (result.rowCount !== 1 || result.rows[0] === undefined) {
        throw new OrderConflictError(`Order ${orderId} could not transition ASSIGNED -> COLLECTED`)
      }
      const order = mapOrder(result.rows[0])
      await insertTransitionEvent(client, order, 'ASSIGNED', actor, correlationId, buildOrderCollectedEvent(order))
      return order
    })
  }

  public async complete(
    orderId: string,
    driverId: string,
    expectedVersion: number,
    proof: { method: 'code'; code: string } | ProofOfDeliveryAsset,
    actor: Actor,
    correlationId: string
  ): Promise<Order> {
    return this.completeInTransaction(orderId, driverId, expectedVersion, proof, actor, correlationId)
  }

  private async completeInTransaction(
    orderId: string,
    driverId: string,
    expectedVersion: number,
    proof: { method: 'code'; code: string } | ProofOfDeliveryAsset,
    actor: Actor,
    correlationId: string
  ): Promise<Order> {
    const result = await inTransaction(this.pool, async (client) => {
      if (proof.method === 'code') {
        const locked = await client.query<OrderRow>('select * from orders where id = $1 for update', [orderId])
        const lockedRow = locked.rows[0]
        if (
          lockedRow === undefined || lockedRow.driver_id !== driverId || lockedRow.status !== 'COLLECTED' ||
          lockedRow.version !== expectedVersion
        ) {
          throw new OrderConflictError(`Order ${orderId} could not transition COLLECTED -> COMPLETED`)
        }
        if (
          lockedRow.delivery_code_hash === null || lockedRow.delivery_code_expires_at === null ||
          lockedRow.delivery_code_expires_at <= new Date()
        ) {
          return { error: new DeliveryCodeExpiredError() }
        }
        if (lockedRow.delivery_code_failed_attempts >= 3) {
          return { error: new DeliveryCodeLockedError() }
        }
        if (!(await verifyDeliveryCode(proof.code, lockedRow.delivery_code_hash))) {
          const failedAttempts = lockedRow.delivery_code_failed_attempts + 1
          await client.query(
            `update orders set delivery_code_failed_attempts = $2::smallint,
             delivery_code_locked_at = case when $2::smallint >= 3 then now() else delivery_code_locked_at end,
             updated_at = now() where id = $1`,
            [orderId, failedAttempts]
          )
          return { error: new DeliveryCodeInvalidError(3 - failedAttempts) }
        }
      }
      const result = await client.query<OrderRow>(
        `update orders
         set status = 'COMPLETED', completed_at = now(), updated_at = now(), version = version + 1,
             delivery_proof_method = $4, delivery_code_plain = null
         where id = $1 and driver_id = $2 and status = 'COLLECTED' and version = $3
         returning *`,
        [orderId, driverId, expectedVersion, proof.method]
      )
      if (result.rowCount !== 1 || result.rows[0] === undefined) {
        throw new OrderConflictError(`Order ${orderId} could not transition COLLECTED -> COMPLETED`)
      }
      const order = mapOrder(result.rows[0])
      if (proof.method !== 'code') {
        await client.query(
          `insert into order_proof_assets (order_id, kind, content, content_type, expires_at)
           values ($1, $2, $3, $4, now() + interval '7 days')`,
          [order.id, proof.method, proof.content, proof.contentType]
        )
      }
      await insertTransitionEvent(client, order, 'COLLECTED', actor, correlationId, buildOrderCompletedEvent(order))
      return { order }
    })
    if ('error' in result) {
      throw result.error
    }
    return result.order
  }

  public async returnOrder(
    orderId: string,
    driverId: string,
    expectedVersion: number,
    actor: Actor,
    correlationId: string
  ): Promise<Order> {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query<OrderRow>(
        `update orders set status = 'RETURNING', updated_at = now(), version = version + 1, delivery_code_plain = null
         where id = $1 and driver_id = $2 and status = 'COLLECTED' and version = $3 returning *`,
        [orderId, driverId, expectedVersion]
      )
      if (result.rowCount !== 1 || result.rows[0] === undefined) {
        throw new OrderConflictError(`Order ${orderId} could not transition COLLECTED -> RETURNING`)
      }
      const order = mapOrder(result.rows[0])
      await insertTransitionEvent(client, order, 'COLLECTED', actor, correlationId, buildOrderReturningEvent(order))
      return order
    })
  }

  public async confirmReturn(
    orderId: string,
    driverId: string,
    expectedVersion: number,
    actor: Actor,
    correlationId: string
  ): Promise<Order> {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query<OrderRow>(
        `update orders set status = 'RETURNED', updated_at = now(), version = version + 1
         where id = $1 and driver_id = $2 and status = 'RETURNING' and version = $3 returning *`,
        [orderId, driverId, expectedVersion]
      )
      if (result.rowCount !== 1 || result.rows[0] === undefined) {
        throw new OrderConflictError(`Order ${orderId} could not transition RETURNING -> RETURNED`)
      }
      const order = mapOrder(result.rows[0])
      await insertTransitionEvent(client, order, 'RETURNING', actor, correlationId, buildOrderReturnedEvent(order))
      return order
    })
  }
}
