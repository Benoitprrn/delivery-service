import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDriversModule } from '../../src/modules/drivers/public.js'
import { startOutboxRelay } from '../../src/platform/outbox-relay.js'
import { pool } from '../../src/platform/db.js'

const driverId = '33333333-3333-3333-3333-333333333333'
const insertedLocationIds: string[] = []

afterEach(async () => {
  if (insertedLocationIds.length > 0) {
    await pool.query('delete from driver_locations where id = any($1::uuid[])', [insertedLocationIds])
    insertedLocationIds.length = 0
  }
})

describe('driver location retention', () => {
  it('stores an expiration exactly seven days after the recorded time', async () => {
    const recordedAt = new Date('2026-09-12T10:30:00.000Z')
    const { recordLocation } = createDriversModule(pool)

    await recordLocation({ driverId, lat: 46.2058, lng: 5.2255, recordedAt })

    const result = await pool.query<{ id: string; recorded_at: Date; expires_at: Date }>(
      `select id, recorded_at, expires_at from driver_locations
       where driver_id = $1 and recorded_at = $2 order by received_at desc limit 1`,
      [driverId, recordedAt]
    )
    const location = result.rows[0]
    if (location === undefined) {
      throw new Error('Inserted driver location was not found')
    }
    insertedLocationIds.push(location.id)

    expect(location.expires_at.getTime()).toBe(location.recorded_at.getTime() + 7 * 24 * 60 * 60 * 1_000)
  })

  it('periodically purges expired locations without deleting valid ones', async () => {
    const expiredId = randomUUID()
    const validId = randomUUID()
    insertedLocationIds.push(expiredId, validId)
    await pool.query(
      `insert into driver_locations (id, driver_id, lat, lng, recorded_at, expires_at)
       values
         ($1, $3, 46.2, 5.2, now() - interval '8 days', now() - interval '1 second'),
         ($2, $3, 46.2, 5.2, now(), now() + interval '7 days')`,
      [expiredId, validId, driverId]
    )

    const stopRelay = startOutboxRelay(pool, vi.fn(), 10)
    try {
      await vi.waitFor(async () => {
        const result = await pool.query<{ id: string }>('select id from driver_locations where id = any($1::uuid[])', [[expiredId, validId]])
        expect(result.rows.map((row) => row.id)).toEqual([validId])
      }, { timeout: 1_000, interval: 20 })
    } finally {
      stopRelay()
    }
  })
})
