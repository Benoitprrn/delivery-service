import type { Pool } from 'pg'

export async function deleteTestOrders(pool: Pool, orderIds: string[]): Promise<void> {
  if (orderIds.length === 0) return

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('alter table order_events disable trigger order_events_no_update')
    await client.query('alter table order_events disable trigger order_events_no_truncate')
    await client.query('delete from order_cash_on_delivery_payments where order_id = any($1::uuid[])', [orderIds])
    await client.query('delete from order_delivery_completion_sessions where order_id = any($1::uuid[])', [orderIds])
    await client.query('delete from dispatch_offers where order_id = any($1::uuid[])', [orderIds])
    await client.query('delete from order_events where order_id = any($1::uuid[])', [orderIds])
    await client.query('delete from outbox_event where aggregate_id = any($1::uuid[])', [orderIds])
    // order_proof_assets.order_id references orders(id) on delete cascade.
    await client.query('delete from orders where id = any($1::uuid[])', [orderIds])
    await client.query('alter table order_events enable trigger order_events_no_update')
    await client.query('alter table order_events enable trigger order_events_no_truncate')
    await client.query('COMMIT')
  } catch (error) {
    // ROLLBACK restores trigger state if cleanup fails before explicit enable.
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
