import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pool } from '../../src/platform/db.js'
import { deleteTestOrders } from '../support/cleanup-orders.js'
import { lockSettlementSingleton } from '../support/settlement-singleton-lock.js'

vi.setConfig({ hookTimeout: 180_000 })
const isolated = /settlement|test/.test((await pool.query<{ d: string }>('select current_database() d')).rows[0]?.d ?? '')
const merchantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
const driverId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1'
const zoneId = '11111111-1111-1111-1111-111111111111'
const orders: string[] = []
let release: (() => Promise<void>) | undefined

async function setGoLive(value: string | null): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query('alter table settlement_settings disable trigger settlement_settings_guard')
    await client.query('update settlement_settings set go_live_at = $1::timestamptz where id = true', [value])
    await client.query('alter table settlement_settings enable trigger settlement_settings_guard')
    await client.query('commit')
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally { client.release() }
}

async function createOrder(deliveryCents: number, serviceFeeCents: number): Promise<string> {
  const id = randomUUID()
  await pool.query(
    `insert into orders(id,merchant_id,driver_id,zone_id,status,customer_name,customer_phone,pickup_address,pickup_lat,pickup_lng,delivery_address,delivery_lat,delivery_lng,distance_m,duration_s,driver_earning_cents,created_at,completed_at)
     values($1::uuid,$2::uuid,$3::uuid,$4::uuid,'COMPLETED','Client','0600000000','Pickup',46.2,5.2,'Delivery',46.21,5.21,3000,720,0,now() - interval '8 days',now() - interval '5 days')`,
    [id, merchantId, driverId, zoneId]
  )
  await pool.query('update orders set delivery_cents=$2, service_fee_cents=$3 where id=$1::uuid', [id, deliveryCents, serviceFeeCents])
  orders.push(id)
  return id
}

async function insertCompleteLedger(deliveries: readonly [number, number][], dueOverride?: number): Promise<{ statement: string; settlement: string }> {
  const period = randomUUID(); const settlement = randomUUID(); const statement = randomUUID()
  const orderIds = await Promise.all(deliveries.map(([delivery, fee]) => createOrder(delivery, fee)))
  const driverAmount = deliveries.reduce((total, [delivery]) => total + delivery, 0)
  const serviceFee = deliveries.reduce((total, [, fee]) => total + fee, 0)
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query("insert into settlement_periods(id,period_start,period_end,payrun_at) values($1::uuid,now() - interval '10 days',now() - interval '3 days',now() - interval '1 minute')", [period])
    await client.query('insert into merchant_settlements(id,period_id,merchant_id,amount_cents,driver_amount_cents,service_fee_cents) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6)', [settlement, period, merchantId, driverAmount + serviceFee, driverAmount, serviceFee])
    await client.query('insert into settlement_statements(id,period_id,driver_id,merchant_id,merchant_settlement_id,due_cents) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6)', [statement, period, driverId, merchantId, settlement, dueOverride ?? driverAmount])
    await client.query(
      `insert into settlement_lines(statement_id,period_id,driver_id,merchant_id,order_id,final_status,finalized_at,order_created_at,delivery_cents,service_fee_cents,pricing_rule_version)
       select $1::uuid,$2::uuid,$3::uuid,$4::uuid,o.id,o.status::text,o.completed_at,o.created_at,o.delivery_cents,o.service_fee_cents,o.pricing_rule_version
         from orders o where o.id = any($5::uuid[])`,
      [statement, period, driverId, merchantId, orderIds]
    )
    await client.query('commit')
    return { statement, settlement }
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally { client.release() }
}

beforeAll(async () => {
  if (!isolated) return
  release = await lockSettlementSingleton(pool)
  await pool.query("insert into merchants(id,name,zone_id) values($1::uuid,'Resto 1',$2::uuid) on conflict do nothing", [merchantId, zoneId])
  await pool.query("insert into drivers(id,name,zone_id) values($1::uuid,'Livreur 1',$2::uuid) on conflict do nothing", [driverId, zoneId])
})
beforeEach(async () => { if (isolated) await setGoLive(new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString()) })
afterEach(async () => {
  if (!isolated) return
  await pool.query('truncate table settlement_lines, settlement_statements, merchant_settlements, settlement_periods cascade')
  await deleteTestOrders(pool, orders.splice(0))
})
afterAll(async () => {
  if (!isolated) return
  await setGoLive(null)
  await pool.query('delete from drivers where id=$1::uuid', [driverId])
  await pool.query('delete from merchants where id=$1::uuid', [merchantId])
  await release?.()
})

describe.skipIf(!isolated)('additive settlement ledger constraints', () => {
  it('accepts the 600/120 + 400/80 worked example with generated merchant amounts', async () => {
    const { statement, settlement } = await insertCompleteLedger([[600, 120], [400, 80]])
    const lines = await pool.query<{ delivery: number; service: number; merchant: number }>('select delivery_cents::int delivery, service_fee_cents::int service, merchant_amount_cents::int merchant from settlement_lines where statement_id=$1::uuid order by delivery_cents desc', [statement])
    expect(lines.rows).toEqual([{ delivery: 600, service: 120, merchant: 720 }, { delivery: 400, service: 80, merchant: 480 }])
    expect((await pool.query('select due_cents::int due from settlement_statements where id=$1::uuid', [statement])).rows).toEqual([{ due: 1000 }])
    expect((await pool.query('select amount_cents::int amount,driver_amount_cents::int driver,service_fee_cents::int service from merchant_settlements where id=$1::uuid', [settlement])).rows).toEqual([{ amount: 1200, driver: 1000, service: 200 }])
  })

  it('rejects a statement whose due is not the sum of delivery amounts at commit', async () => {
    await expect(insertCompleteLedger([[600, 120]], 480)).rejects.toThrow(/montant dû du statement/)
  })

  it('keeps the ledger append-only and statement due immutable', async () => {
    const { statement } = await insertCompleteLedger([[600, 120]])
    await expect(pool.query('update settlement_lines set delivery_cents=0 where statement_id=$1::uuid', [statement])).rejects.toThrow(/append-only/)
    await expect(pool.query('update settlement_statements set due_cents=0 where id=$1::uuid', [statement])).rejects.toThrow(/immuables/)
  })
})
