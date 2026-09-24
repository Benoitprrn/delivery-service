import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '../../src/platform/db.js'
import { PostgresOrderRepository } from '../../src/modules/orders/infrastructure/postgres-order-repository.js'
import { deleteTestOrders } from '../support/cleanup-orders.js'

// Ces tests TRONQUENT/ÉCRIVENT des tables de règlement : ils ne tournent que sur une base isolée (`source docs/work/r10-testdb.sh`),
// jamais sur la base de dev (là, ils sont ignorés).
const isolated = /settlement|test/.test((await pool.query<{ d: string }>('select current_database() d')).rows[0]?.d ?? '')

// Base isolée requise (migration 0034 = trigger d'immutabilité) : `source docs/work/r10-testdb.sh reset`.
// Entités DÉDIÉES : aucune interférence avec les fixtures partagées dont d'autres tests comptent les commandes.
const merchantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3'
const driverId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb3'
const zoneId = '11111111-1111-1111-1111-111111111111'
const repository = new PostgresOrderRepository(pool)
const orders: string[] = []
const DAY = 86_400_000

type Status = 'COMPLETED' | 'RETURNED' | 'RETURNING' | 'CANCELLED' | 'COLLECTED'
interface Spec { id?: string; status?: Status; createdAt: Date; completedAt?: Date | null; returnedAt?: Date | null; earning?: number; distance?: number; duration?: number }

async function order(spec: Spec): Promise<string> {
  const id = spec.id ?? randomUUID()
  const status = spec.status ?? 'COMPLETED'
  const driver = status === 'CANCELLED' ? null : driverId
  await pool.query(
    `insert into orders(id,merchant_id,driver_id,zone_id,status,customer_name,customer_phone,pickup_address,pickup_lat,pickup_lng,delivery_address,delivery_lat,delivery_lng,distance_m,duration_s,driver_earning_cents,created_at,completed_at)
     values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::order_status,'Client','0600000000','Pickup',46.2,5.2,'Delivery',46.21,5.21,$6::int,$7::int,$8::int,$9::timestamptz,$10::timestamptz)`,
    [id, merchantId, driver, zoneId, status, spec.distance ?? 3000, spec.duration ?? 720, spec.earning ?? 475, spec.createdAt, status === 'COMPLETED' ? spec.completedAt ?? null : null])
  const delivery = spec.earning ?? 475
  await pool.query('update orders set delivery_cents=$2, service_fee_cents=$3 where id=$1::uuid', [id, delivery, Math.floor((delivery * 2_000) / 10_000)])
  orders.push(id)
  if (status === 'RETURNED' && spec.returnedAt) {
    await pool.query("insert into order_events(order_id,from_status,to_status,actor_type,correlation_id,created_at) values($1::uuid,'RETURNING','RETURNED','system',gen_random_uuid(),$2::timestamptz)", [id, spec.returnedAt])
  }
  return id
}

let from: Date
let to: Date
let goLive: Date
beforeAll(async () => {
  if (!isolated) return
  await pool.query("insert into merchants(id,name,zone_id) values($1::uuid,'Resto 3',$2::uuid) on conflict do nothing", [merchantId, zoneId])
  await pool.query("insert into drivers(id,name,zone_id) values($1::uuid,'Livreur 3',$2::uuid) on conflict do nothing", [driverId, zoneId])
  const t = (await pool.query<{ t: Date }>("select date_trunc('second', now()) t")).rows[0]?.t as Date
  from = new Date(t.getTime() - 10 * DAY)
  to = new Date(t.getTime() - 3 * DAY)
  goLive = new Date(t.getTime() - 60 * DAY)
})
afterEach(async () => { if (isolated) await deleteTestOrders(pool, orders.splice(0)) })
afterAll(async () => {
  if (!isolated) return
  await pool.query('delete from drivers where id = $1::uuid', [driverId])
  await pool.query('delete from merchants where id = $1::uuid', [merchantId])
})

const created = () => new Date(from.getTime() - 5 * DAY)
const win = () => ({ finalizedFrom: from, finalizedTo: to, createdNotBefore: goLive })

describe.skipIf(!isolated)('listSettleableOrders', () => {
  it('uses a half-open [from, to) window on completed_at for COMPLETED orders', async () => {
    const atFrom = await order({ createdAt: created(), completedAt: from })
    const justBefore = await order({ createdAt: created(), completedAt: new Date(from.getTime() - 1) })
    const inside = await order({ createdAt: created(), completedAt: new Date(from.getTime() + DAY) })
    const justBeforeTo = await order({ createdAt: created(), completedAt: new Date(to.getTime() - 1) })
    const atTo = await order({ createdAt: created(), completedAt: to })
    const ids = (await repository.listSettleableOrders(win())).map(o => o.orderId)
    expect(ids).toEqual(expect.arrayContaining([atFrom, inside, justBeforeTo]))
    expect(ids).not.toContain(justBefore)
    expect(ids).not.toContain(atTo)
  })

  it('takes finalizedAt of a RETURNED order from its order_events row, not from the order', async () => {
    const eventAt = new Date(from.getTime() + 2 * DAY)
    const returned = await order({ status: 'RETURNED', createdAt: created(), returnedAt: eventAt })
    const before = await order({ status: 'RETURNED', createdAt: created(), returnedAt: new Date(from.getTime() - 1) })
    const noEvent = await order({ status: 'RETURNED', createdAt: created(), returnedAt: null })
    const list = await repository.listSettleableOrders(win())
    const found = list.find(o => o.orderId === returned)
    expect(found).toMatchObject({ finalStatus: 'RETURNED', driverId, merchantId })
    expect(found?.finalizedAt.getTime()).toBe(eventAt.getTime())
    expect(list.map(o => o.orderId)).not.toContain(before)
    expect(list.map(o => o.orderId)).not.toContain(noEvent)
  })

  it('never lists RETURNING, CANCELLED or any non final status, even inside the window', async () => {
    const inside = new Date(from.getTime() + DAY)
    const returning = await order({ status: 'RETURNING', createdAt: created() })
    const cancelled = await order({ status: 'CANCELLED', createdAt: created() })
    const collected = await order({ status: 'COLLECTED', createdAt: created() })
    await pool.query("insert into order_events(order_id,from_status,to_status,actor_type,correlation_id,created_at) values($1::uuid,'COLLECTED','RETURNING','system',gen_random_uuid(),$2::timestamptz)", [returning, inside])
    // Donnée incohérente volontaire : un événement RETURNED sur une commande encore RETURNING ne la rend pas réglable.
    await pool.query("insert into order_events(order_id,from_status,to_status,actor_type,correlation_id,created_at) values($1::uuid,'RETURNING','RETURNED','system',gen_random_uuid(),$2::timestamptz)", [returning, inside])
    const ids = (await repository.listSettleableOrders(win())).map(o => o.orderId)
    for (const id of [returning, cancelled, collected]) expect(ids).not.toContain(id)
  })

  it('excludes orders created before createdNotBefore (go_live_at) and keeps those created at that instant', async () => {
    const before = await order({ createdAt: new Date(goLive.getTime() - 1), completedAt: new Date(from.getTime() + DAY) })
    const atGoLive = await order({ createdAt: goLive, completedAt: new Date(from.getTime() + DAY) })
    const ids = (await repository.listSettleableOrders(win())).map(o => o.orderId)
    expect(ids).not.toContain(before)
    expect(ids).toContain(atGoLive)
  })

  it('returns frozen delivery, service fee and pricing rule amounts, never recomputed', async () => {
    const id = await order({ createdAt: created(), completedAt: new Date(from.getTime() + DAY), earning: 300 })
    const found = (await repository.listSettleableOrders(win())).find(o => o.orderId === id)
    expect(found).toMatchObject({ deliveryCents: 300, serviceFeeCents: 60, pricingRuleVersion: expect.any(Number) })
  })

  it('orders results by finalizedAt then id and rejects an empty or inverted window', async () => {
    // ids choisis pour qu'un tri par id, croissant OU décroissant, diffère du tri par date de finalisation (A < B < C)
    const a = await order({ id: '80000000-0000-4000-8000-000000000000', createdAt: created(), completedAt: new Date(from.getTime() + DAY) })
    const b = await order({ id: '00000000-0000-4000-8000-000000000001', createdAt: created(), completedAt: new Date(from.getTime() + 2 * DAY) })
    const c = await order({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', createdAt: created(), completedAt: new Date(from.getTime() + 3 * DAY) })
    const ids = (await repository.listSettleableOrders(win())).map(o => o.orderId).filter(id => [a, b, c].includes(id))
    expect(ids).toEqual([a, b, c])
    const tieAt = new Date(from.getTime() + 4 * DAY)
    const t2 = await order({ id: '00000000-0000-4000-8000-0000000000b2', createdAt: created(), completedAt: tieAt })
    const t1 = await order({ id: '00000000-0000-4000-8000-0000000000a1', createdAt: created(), completedAt: tieAt })
    const tied = (await repository.listSettleableOrders(win())).map(o => o.orderId).filter(id => id === t1 || id === t2)
    expect(tied).toEqual([t1, t2]) // égalité de date : départage par id croissant
    await expect(repository.listSettleableOrders({ ...win(), finalizedTo: from })).rejects.toThrow(/finalizedFrom/)
    await expect(repository.listSettleableOrders({ ...win(), finalizedTo: new Date(from.getTime()) })).rejects.toThrow(/finalizedFrom/)
  })
})

describe.skipIf(!isolated)('order pricing immutability (migration 0034)', () => {
  const at = () => new Date(from.getTime() + DAY)

  it.each(['distance_m', 'duration_s'])('refuses any change of %s after creation', async column => {
    const id = await order({ createdAt: created(), completedAt: at() })
    await expect(pool.query(`update orders set ${column} = ${column} + 1 where id = $1`, [id])).rejects.toThrow(/immuables/)
    await expect(pool.query(`update orders set ${column} = ${column} where id = $1`, [id])).resolves.toBeDefined() // même valeur : sans effet
  })

  it('freezes driver_earning_cents once initialized (475 -> 476 refused, 475 -> 0 refused)', async () => {
    const id = await order({ createdAt: created(), completedAt: at(), earning: 475 })
    await expect(pool.query('update orders set driver_earning_cents = 476 where id = $1', [id])).rejects.toThrow(/driver_earning_cents est immuable/)
    await expect(pool.query('update orders set driver_earning_cents = 0 where id = $1', [id])).rejects.toThrow(/driver_earning_cents est immuable/)
  })

  it('allows the creation flow placeholder 0 -> price_cents exactly once, and nothing else from 0', async () => {
    const wrong = await order({ createdAt: created(), completedAt: at(), earning: 0 })
    await expect(pool.query('update orders set driver_earning_cents = 500 where id = $1', [wrong])).rejects.toThrow(/driver_earning_cents est immuable/)
    await pool.query('update orders set driver_earning_cents = price_cents where id = $1', [wrong])
    const stored = await pool.query<{ driver_earning_cents: number; price_cents: number }>('select driver_earning_cents, price_cents from orders where id = $1', [wrong])
    expect(stored.rows[0]?.driver_earning_cents).toBe(stored.rows[0]?.price_cents)
    await expect(pool.query('update orders set driver_earning_cents = driver_earning_cents + 1 where id = $1', [wrong])).rejects.toThrow(/driver_earning_cents est immuable/)
    const stored300 = await order({ createdAt: created(), completedAt: at(), earning: 300 })
    await expect(pool.query('update orders set driver_earning_cents = price_cents where id = $1', [stored300])).rejects.toThrow(/driver_earning_cents est immuable/) // hors espace réservé 0 : figé
  })

  it('leaves other order updates untouched and is not executable by anon/authenticated/PUBLIC', async () => {
    const id = await order({ createdAt: created(), completedAt: at() })
    await pool.query("update orders set customer_name = 'Autre' where id = $1", [id])
    const fn = await pool.query<{ anon: boolean; authenticated: boolean; pub: boolean }>(
      `select has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') authenticated,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') pub
       from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'guard_order_pricing_immutable'`)
    expect(fn.rows).toEqual([{ anon: false, authenticated: false, pub: false }])
  })
})
