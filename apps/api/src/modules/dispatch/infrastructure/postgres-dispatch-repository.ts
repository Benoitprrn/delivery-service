import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../../../platform/pg-error.js'
import { inTransaction } from '../../../platform/transaction.js'
import { DispatchOfferConflictError } from '../domain/errors.js'
import type { DispatchOffer } from '../domain/dispatch-offer.js'
import type { DispatchRepository } from '../ports/dispatch-repository.js'

type DispatchOfferRow = {
  id: string
  order_id: string
  driver_id: string
  round: number
  radius_km: string | number | null
  status: DispatchOffer['status']
  version: number
  expires_at: Date
  created_at: Date
  responded_at: Date | null
}

function mapOffer(row: DispatchOfferRow): DispatchOffer {
  return {
    id: row.id,
    orderId: row.order_id,
    driverId: row.driver_id,
    round: row.round,
    radiusKm: row.radius_km === null ? null : Number(row.radius_km),
    status: row.status,
    version: row.version,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    respondedAt: row.responded_at
  }
}

function constraintName(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'constraint' in error) {
    const { constraint } = error
    return typeof constraint === 'string' ? constraint : undefined
  }
  return undefined
}

export class PostgresDispatchRepository implements DispatchRepository {
  public constructor(private readonly pool: Pool) {}

  public async createOffer(
    orderId: string,
    driverId: string,
    round: number,
    radiusKm: number | null,
    expiresAt: Date
  ): Promise<DispatchOffer> {
    try {
      return await inTransaction(this.pool, async (client) => {
        const result = await client.query<DispatchOfferRow>(
          `insert into dispatch_offers (order_id, driver_id, round, radius_km, expires_at)
           values ($1, $2, $3, $4, $5)
           returning *`,
          [orderId, driverId, round, radiusKm, expiresAt]
        )
        const row = result.rows[0]
        if (row === undefined) throw new Error('Dispatch offer insert did not return a row')
        const offer = mapOffer(row)
        await client.query(
          `insert into outbox_event (event_type, aggregate_type, aggregate_id, aggregate_version, payload, correlation_id)
           values ('dispatch.offer_created.v1', 'dispatch_offer', $1, 1, $2::jsonb, $3)`,
          [offer.id, JSON.stringify({ offerId: offer.id, orderId, driverId, round, radiusKm, expiresAt: expiresAt.toISOString() }), randomUUID()]
        )
        return offer
      })
    } catch (error) {
      if (
        pgErrorCode(error) === PG_UNIQUE_VIOLATION &&
        constraintName(error) === 'dispatch_offers_one_active_per_driver'
      ) {
        throw new DispatchOfferConflictError(`Driver ${driverId} already has an active dispatch offer`)
      }
      throw error
    }
  }

  public async findActiveByDriverId(driverId: string): Promise<DispatchOffer | null> {
    const result = await this.pool.query<DispatchOfferRow>(
      `select * from dispatch_offers
       where driver_id = $1 and status = 'ACTIVE'
       order by created_at desc
       limit 1`,
      [driverId]
    )
    const row = result.rows[0]
    return row === undefined ? null : mapOffer(row)
  }

  public async findActiveByOrderId(orderId: string): Promise<DispatchOffer | null> {
    const result = await this.pool.query<DispatchOfferRow>(
      `select * from dispatch_offers where order_id = $1 and status = 'ACTIVE' order by created_at desc limit 1`,
      [orderId]
    )
    const row = result.rows[0]
    return row === undefined ? null : mapOffer(row)
  }

  public async findById(offerId: string): Promise<DispatchOffer | null> {
    const result = await this.pool.query<DispatchOfferRow>('select * from dispatch_offers where id = $1', [offerId])
    const row = result.rows[0]
    return row === undefined ? null : mapOffer(row)
  }

  public accept(offerId: string, expectedVersion: number): Promise<DispatchOffer> {
    return this.transition(offerId, expectedVersion, 'ACCEPTED')
  }

  public reject(offerId: string, expectedVersion: number): Promise<DispatchOffer> {
    return this.transition(offerId, expectedVersion, 'REJECTED')
  }

  public expire(offerId: string, expectedVersion: number): Promise<DispatchOffer> {
    return this.transition(offerId, expectedVersion, 'EXPIRED')
  }

  private async transition(
    offerId: string,
    expectedVersion: number,
    status: Extract<DispatchOffer['status'], 'ACCEPTED' | 'REJECTED' | 'EXPIRED'>
  ): Promise<DispatchOffer> {
    const result = await this.pool.query<DispatchOfferRow>(
      `update dispatch_offers
       set status = $1, responded_at = now(), version = version + 1
       where id = $2 and status = 'ACTIVE' and version = $3
       returning *`,
      [status, offerId, expectedVersion]
    )
    const row = result.rows[0]
    if (result.rowCount !== 1 || row === undefined) {
      throw new DispatchOfferConflictError(`Dispatch offer ${offerId} is no longer active`)
    }
    return mapOffer(row)
  }
}
