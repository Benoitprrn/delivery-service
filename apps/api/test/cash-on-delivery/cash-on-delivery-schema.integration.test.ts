import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { pool } from '../../src/platform/db.js'
import { deleteTestOrders } from '../support/cleanup-orders.js'

const merchantId = '22222222-2222-2222-2222-222222222222'
const driverId = '33333333-3333-3333-3333-333333333333'
const zoneId = '11111111-1111-1111-1111-111111111111'
const orders: string[] = []
const createdOrderIds: string[] = []

async function order(required = true): Promise<string> {
  const id = randomUUID()
  await pool.query(`insert into orders (id,merchant_id,driver_id,zone_id,status,customer_name,customer_phone,pickup_address,pickup_lat,pickup_lng,delivery_address,delivery_lat,delivery_lng,distance_m,duration_s,driver_earning_cents,cash_on_delivery_required,cash_on_delivery_amount_cents,cash_on_delivery_currency,cash_on_delivery_created_at) values ($1,$2,$3,$4,'COLLECTED','Client','0600000000','Pickup',46.2,5.2,'Delivery',46.21,5.23,0,0,400,$5,$6,$7,$8)`, [id, merchantId, driverId, zoneId, required, required ? 5000 : null, required ? 'eur' : null, required ? new Date() : null])
  orders.push(id); createdOrderIds.push(id)
  return id
}
async function session(orderId: string, status = 'open'): Promise<string> { const id = randomUUID(); await pool.query('insert into order_delivery_completion_sessions(id,order_id,driver_id,expected_order_version,status,expires_at) values($1,$2,$3,1,$4,now()+interval \'1 hour\')', [id, orderId, driverId, status]); return id }
async function payment(orderId: string, sessionId: string, over: Record<string, unknown> = {}): Promise<string> { const id = randomUUID(); const v = { attempt: 1, amount: 5000, currency: 'eur', status: 'created', reader: 'bluetooth', intent: null, ...over }; await pool.query('insert into order_cash_on_delivery_payments(id,order_id,session_id,merchant_id,driver_id,attempt_no,stripe_account_id,amount_cents,currency,stripe_payment_intent_id,status,capture_idempotency_key,create_idempotency_key,reader_type,terminal_location_id) values($1,$2,$3,$4,$5,$6,\'acct_test\',$7,$8,$9,$10,$11,$12,$13,\'tml_test\')', [id, orderId, sessionId, merchantId, driverId, v.attempt, v.amount, v.currency, v.intent, v.status, `capture-${id}`, `create-${id}`, v.reader]); return id }

afterEach(async () => { await deleteTestOrders(pool, orders.splice(0)); await pool.query('delete from merchant_terminal_locations where merchant_id=$1', [merchantId]); await pool.query('delete from merchant_stripe_connect where merchant_id=$1', [merchantId]) })
afterAll(async () => {
  const r = await pool.query<{ count: string }>(`select count(*) from orders where id = any($1::uuid[]) union all select count(*) from order_delivery_completion_sessions where order_id = any($1::uuid[]) union all select count(*) from order_cash_on_delivery_payments where order_id = any($1::uuid[])`, [createdOrderIds])
  expect(r.rows.map(x => Number(x.count))).toEqual([0, 0, 0])
})

describe('cash on delivery schema', () => {
  it('trigger rejects divergent snapshot and accepts exact snapshot', async () => { const id = await order(); const s = await session(id); await expect(payment(id, s, { amount: 4999 })).rejects.toThrow('cash on delivery payment must match order snapshot'); await expect(payment(id, s)).resolves.toBeDefined() })
  it('trigger rejects wrong currency and non-COD order', async () => { const id = await order(); const s = await session(id); await expect(payment(id, s, { currency: 'usd' })).rejects.toThrow('cash on delivery payment must match order snapshot'); const nonCod = await order(false); const other = await session(nonCod); await expect(payment(nonCod, other)).rejects.toThrow('cash on delivery payment must match order snapshot') })
  it('enforces one active session and allows one after terminal session', async () => { const id = await order(); await session(id); await expect(session(id)).rejects.toThrow(); await pool.query("update order_delivery_completion_sessions set status='completed' where order_id=$1", [id]); await expect(session(id)).resolves.toBeDefined() })
  it.each(['abandoned', 'expired'])('allows active session after %s', async status => { const id = await order(); await session(id, status); await expect(session(id)).resolves.toBeDefined() })
  it('enforces one active payment and allows retry after terminal payment', async () => { const id = await order(); const s = await session(id); await payment(id, s); await expect(payment(id, s, { attempt: 2 })).rejects.toThrow(); await pool.query("update order_cash_on_delivery_payments set status='failed' where order_id=$1", [id]); await expect(payment(id, s, { attempt: 2 })).resolves.toBeDefined() })
  it.each(['canceled'])('allows retry after %s payment', async status => { const id = await order(); const s = await session(id); await payment(id, s, { status }); await expect(payment(id, s, { attempt: 2 })).resolves.toBeDefined() })
  it('enforces one captured payment, unique PI and unique attempt', async () => { const id = await order(); const s = await session(id); await payment(id, s, { status: 'captured', intent: 'pi_unique' }); await expect(payment(id, s, { attempt: 2, status: 'captured' })).rejects.toThrow(); const second = await order(); const secondSession = await session(second); await expect(payment(second, secondSession, { intent: 'pi_unique' })).rejects.toThrow(); await expect(payment(id, s, { status: 'failed', intent: 'pi_other' })).rejects.toThrow() })
  it.each([{ amount: 99 }, { amount: 50001 }, { reader: 'nfc' }, { status: 'bogus' }])('rejects payment CHECK %#', async over => { const id = await order(); const s = await session(id); await expect(payment(id, s, over)).rejects.toThrow() })
  it('enables RLS and revokes Data API roles', async () => { const result = await pool.query<{ relname: string; relrowsecurity: boolean; allowed: boolean }>(`select c.relname,c.relrowsecurity,has_table_privilege(r.role_name,c.oid,'select') as allowed from pg_class c cross join (values ('anon'::name),('authenticated'::name)) r(role_name) where c.relname in ('merchant_stripe_connect','merchant_terminal_locations','order_delivery_completion_sessions','order_cash_on_delivery_payments') order by c.relname,r.role_name`); expect(result.rows).toHaveLength(8); expect(result.rows.every(row => row.relrowsecurity && !row.allowed)).toBe(true) })
})
