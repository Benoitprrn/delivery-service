import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pool } from '../../src/platform/db.js'
import { deleteTestOrders } from '../support/cleanup-orders.js'
import { lockSettlementSingleton } from '../support/settlement-singleton-lock.js'

// Ces tests TRONQUENT/ÉCRIVENT des tables de règlement : ils ne tournent que sur une base isolée (`source docs/work/r10-testdb.sh`),
// jamais sur la base de dev (là, ils sont ignorés).
// Ces fichiers se partagent les tables de règlement : le verrou global peut attendre la fin de l'autre fichier.
vi.setConfig({ hookTimeout: 180_000 })
const isolated = /settlement|test/.test((await pool.query<{ d: string }>('select current_database() d')).rows[0]?.d ?? '')

// Ces tests TRONQUENT les tables de règlement et désactivent temporairement le trigger d'immutabilité de
// go_live_at : uniquement sur une base isolée (`source docs/work/r10-testdb.sh`), jamais la base de dev.
// Entités DÉDIÉES : aucune interférence avec les fixtures partagées (restaurant 2222…/livreur 3333…) dont d'autres tests comptent les commandes.
const merchantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
const driverId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1'
const zoneId = '11111111-1111-1111-1111-111111111111'
const merchant2Id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'
const driver2Id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2'
const orders: string[] = []

const SETTLEMENT_TABLES = ['settlement_pre_notifications', 'settlement_reconciliation_findings', 'settlement_reconciliation_runs', 'driver_receivables', 'merchant_receivables',
  'driver_transfer_reversals', 'driver_transfers', 'driver_pay_runs', 'debit_attempts', 'driver_payout_observations', 'driver_connect_accounts',
  'settlement_lines', 'settlement_statements', 'merchant_settlements', 'settlement_periods']
const ALL_TABLES = ['settlement_settings', ...SETTLEMENT_TABLES]
const GO_LIVE = "now() - interval '200 days'"

// Prix (= gain livreur, ADR 0002) -> (distance_m, duration_s) produisant exactement ce prix.
const SHAPE: Record<number, [number, number]> = { 400: [500, 180], 401: [5000, 317], 475: [3000, 720], 909: [7000, 1500] }
const fee = (earning: number, bps = 2000): number => Math.floor((earning * bps) / 10000)

type Q = (text: string, values?: unknown[]) => Promise<unknown>
const viaPool: Q = (text, values) => pool.query(text, values)
const viaClient = (client: PoolClient): Q => (text, values) => client.query(text, values)

async function setGoLive(sqlExpression: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query('alter table settlement_settings disable trigger settlement_settings_guard')
    await client.query(`update settlement_settings set go_live_at = ${sqlExpression} where id = true`)
    await client.query('alter table settlement_settings enable trigger settlement_settings_guard')
    await client.query('commit')
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

interface OrderSpec { earning?: number; status?: 'COMPLETED' | 'RETURNED' | 'RETURNING' | 'CANCELLED'; driver?: string; merchant?: string; createdAt?: string; completedAt?: string; returnedAt?: string }
interface Ord { id: string; price: number; status: string; completedAt: Date | null; returnedAt: Date | null }

async function mkOrder(spec: OrderSpec = {}): Promise<Ord> {
  const earning = spec.earning ?? 475
  const shape = SHAPE[earning]
  if (shape === undefined) throw new Error(`gain de test inconnu: ${earning}`)
  const status = spec.status ?? 'COMPLETED'
  const id = randomUUID()
  const driver = status === 'CANCELLED' ? null : spec.driver ?? driverId
  const completedAt = status === 'COMPLETED' ? spec.completedAt ?? "now() - interval '5 days'" : 'null'
  await pool.query(
    `insert into orders(id,merchant_id,driver_id,zone_id,status,customer_name,customer_phone,pickup_address,pickup_lat,pickup_lng,delivery_address,delivery_lat,delivery_lng,distance_m,duration_s,driver_earning_cents,created_at,completed_at)
     values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::order_status,'Client','0600000000','Pickup',46.2,5.2,'Delivery',46.21,5.21,$6::int,$7::int,$8::int,${spec.createdAt ?? "now() - interval '8 days'"},${completedAt})`,
    [id, spec.merchant ?? merchantId, driver, zoneId, status, shape[0], shape[1], earning])
  orders.push(id)
  if (status === 'RETURNED') {
    await pool.query(`insert into order_events(order_id,from_status,to_status,actor_type,correlation_id,created_at) values($1::uuid,'RETURNING','RETURNED','system',gen_random_uuid(),${spec.returnedAt ?? "now() - interval '4 days'"})`, [id])
  }
  const row = await pool.query<{ price_cents: number; completed_at: Date | null; returned_at: Date | null }>(
    "select price_cents, completed_at, (select min(created_at) from order_events where order_id=$1 and to_status='RETURNED') as returned_at from orders where id=$1", [id])
  const r = row.rows[0]
  if (r === undefined) throw new Error('commande absente')
  if (r.price_cents !== earning) throw new Error(`prix inattendu ${r.price_cents} != ${earning}`)
  return { id, price: r.price_cents, status, completedAt: r.completed_at, returnedAt: r.returned_at }
}

interface LineOver { finalStatus: string; finalizedAt: Date | null; merchantAmount: number; earning: number; feeCents: number; bps: number }
async function insertLine(q: Q, ids: { statement: string; period: string; driver: string; merchant: string }, order: Ord, over: Partial<LineOver> = {}): Promise<void> {
  const finalStatus = over.finalStatus ?? order.status
  // Sans surcharge, finalized_at est lu en SQL (microsecondes exactes) : un Date JS n'a que la milliseconde.
  const finalizedAt = over.finalizedAt ?? null
  const earning = over.earning ?? order.price
  const bps = over.bps ?? 2000
  await q(
    `insert into settlement_lines(statement_id,period_id,driver_id,merchant_id,order_id,final_status,finalized_at,order_created_at,merchant_amount_cents,driver_earning_cents,fee_rate_bps,fee_rule_version,fee_cents)
     select $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::text,coalesce($7::timestamptz, case when $6::text = 'RETURNED' then (select min(created_at) from order_events where order_id = $5::uuid and to_status = 'RETURNED') else completed_at end),created_at,$8::bigint,$9::bigint,$10::int,1,$11::bigint from orders where id=$5::uuid`,
    [ids.statement, ids.period, ids.driver, ids.merchant, order.id, finalStatus, finalizedAt, over.merchantAmount ?? order.price, earning, bps, over.feeCents ?? fee(earning, bps)])
}

interface Ledger { period: string; settlement: string; statement: string; driver: string; merchant: string; gross: number; fee: number; due: number; orders: Ord[] }
interface LedgerOpts { earnings?: number[]; specs?: OrderSpec[]; driver?: string; merchant?: string; offsetDays?: number; payrunAt?: string }

// Période de 7 jours [now-10j-offset, now-3j-offset) ; commandes de test finalisées dedans. Deux ledgers d'un même test
// doivent avoir des `offsetDays` différents (les périodes ne se chevauchent pas).
async function ledger(opts: LedgerOpts = {}): Promise<Ledger> {
  const driver = opts.driver ?? driverId
  const merchant = opts.merchant ?? merchantId
  const offset = opts.offsetDays ?? 0
  const specs = opts.specs ?? (opts.earnings ?? [475]).map(earning => ({ earning }))
  const ords: Ord[] = []
  for (const spec of specs) {
    ords.push(await mkOrder({ driver, merchant, createdAt: `now() - interval '${8 + offset} days'`, completedAt: `now() - interval '${5 + offset} days'`, returnedAt: `now() - interval '${4 + offset} days'`, ...spec }))
  }
  const gross = ords.reduce((a, o) => a + o.price, 0)
  const fees = ords.reduce((a, o) => a + fee(o.price), 0)
  const period = randomUUID(); const settlement = randomUUID(); const statement = randomUUID()
  const payrunAt = opts.payrunAt ?? "now() - interval '1 minute'"
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query(`insert into settlement_periods(id,period_start,period_end,payrun_at) values($1::uuid, now() - interval '${10 + offset} days', now() - interval '${3 + offset} days', ${payrunAt})`, [period])
    await client.query(`insert into merchant_settlements(id,period_id,merchant_id,amount_cents) values($1::uuid,$2::uuid,$3::uuid,$4::bigint)`, [settlement, period, merchant, gross])
    await client.query('insert into settlement_statements(id,period_id,driver_id,merchant_id,merchant_settlement_id,gross_cents,fee_cents,due_cents) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bigint,$7::bigint,$8::bigint)', [statement, period, driver, merchant, settlement, gross, fees, gross - fees])
    for (const o of ords) await insertLine(viaClient(client), { statement, period, driver, merchant }, o)
    await client.query('commit')
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
  return { period, settlement, statement, driver, merchant, gross, fee: fees, due: gross - fees, orders: ords }
}

interface DebitOver { status: string; attempt: number; charge: string | null; livemode: boolean; amount: number }
async function debit(l: Ledger, over: Partial<DebitOver> = {}): Promise<string> {
  const id = randomUUID()
  const status = over.status ?? 'succeeded'
  const charge = over.charge === undefined ? `py_${id.slice(0, 8)}` : over.charge
  await pool.query(
    `insert into debit_attempts(id,merchant_settlement_id,attempt_no,amount_cents,stripe_account_id,stripe_payment_intent_id,stripe_charge_id,idempotency_key,status,succeeded_at,livemode,mandate_reference,failed_at,failure_code)
     values($1::uuid,$2::uuid,$3::int,$4::bigint,'acct_test',$5,$6,$7,$8::text,$9::timestamptz,$10::boolean,'MANDATE-TEST',case when $8::text = 'failed' then now() end,case when $8::text = 'failed' then 'card_declined' end)`,
    [id, l.settlement, over.attempt ?? 1, over.amount ?? l.gross, status === 'succeeded' || status === 'processing' ? `pi_${id.slice(0, 8)}` : null, status === 'creating' ? null : charge, `d-${id}`, status, status === 'succeeded' ? new Date() : null, over.livemode ?? false])
  return id
}
// La pré-notification `sent` est la SEULE source de `pre_notified_at` (trigger de miroir, migration 0035).
async function notify(l: Ledger, at = "now() - interval '3 days'", attemptNo = 1): Promise<void> {
  await pool.query(
    `insert into settlement_pre_notifications(merchant_settlement_id,amount_cents,attempt_no,requested_by,retry_reason,status,attempt_count,recipient_email,debit_date,iban_last4,mandate_reference,creditor_id,provider,provider_message_id,sent_at)
     values($1::uuid,$2::bigint,$3::int,case when $3::int > 1 then $4::uuid end,case when $3::int > 1 then 'relance test' end,'sent',1,'m@example.test',((${at})::timestamptz at time zone 'Europe/Paris')::date + 2,'1234','MANDATE-TEST','CREDITOR-TEST','resend','msg-test',(${at})::timestamptz)`,
    [l.settlement, l.gross, attemptNo, merchantId])
}
async function payRun(l: Ledger, kind: 'grouped' | 'drip' = 'grouped', when?: string): Promise<string> {
  const id = randomUUID()
  await pool.query(`insert into driver_pay_runs(id,period_id,driver_id,run_kind,scheduled_for) values($1::uuid,$2::uuid,$3::uuid,$4::text,${when ?? '(select payrun_at from settlement_periods where id=$2::uuid)'})`, [id, l.period, l.driver, kind])
  return id
}
async function chargeOf(debitId: string): Promise<string> {
  return (await pool.query<{ c: string }>('select stripe_charge_id c from debit_attempts where id=$1::uuid', [debitId])).rows[0]?.c ?? ''
}
interface TransferOver { amount: number; status: string; tryNo: number; charge: string; mode: string; livemode: boolean; key: string }
async function transfer(l: Ledger, debitId: string, runId: string, over: Partial<TransferOver> = {}): Promise<string> {
  const id = randomUUID()
  const status = over.status ?? 'creating'
  await pool.query(
    `insert into driver_transfers(id,statement_id,pay_run_id,debit_attempt_id,stripe_charge_id,amount_cents,funding_mode,try_no,idempotency_key,status,stripe_transfer_id,succeeded_at,livemode)
     values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::bigint,$7,$8::int,$9,$10::text,$11,$12::timestamptz,$13::boolean)`,
    [id, l.statement, runId, debitId, over.charge ?? await chargeOf(debitId), over.amount ?? l.due, over.mode ?? 'source_transaction', over.tryNo ?? 1, over.key ?? `t-${id}`, status, status === 'succeeded' ? `tr_${id.slice(0, 8)}` : null, status === 'succeeded' ? new Date() : null, over.livemode ?? false])
  return id
}
// Un transfert `succeeded` exige, dans la MÊME transaction, paid_cents = Σ transferts réussis (contrainte différée).
async function paidTransfer(l: Ledger, debitId: string, runId: string, amount = l.due): Promise<string> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const id = randomUUID()
    await client.query(
      `insert into driver_transfers(id,statement_id,pay_run_id,debit_attempt_id,stripe_charge_id,amount_cents,try_no,idempotency_key,status,stripe_transfer_id,succeeded_at,livemode)
       select $1::uuid,$2::uuid,$3::uuid,$4::uuid,stripe_charge_id,$5::bigint,1,$6,'succeeded',$7,now(),livemode from debit_attempts where id=$4::uuid`,
      [id, l.statement, runId, debitId, amount, `t-${id}`, `tr_${id.slice(0, 8)}`])
    await client.query("update settlement_statements set paid_cents = paid_cents + $2::bigint, status = case when paid_cents + $2::bigint = due_cents then 'paid' else 'partial' end where id=$1::uuid", [l.statement, amount])
    await client.query('commit')
    return id
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

async function expectRejects(p: Promise<unknown>, pattern: RegExp): Promise<void> {
  await expect(p).rejects.toThrow(pattern)
}

let releaseSingleton: (() => Promise<void>) | undefined
beforeAll(async () => {
  if (!isolated) return
  releaseSingleton = await lockSettlementSingleton(pool)
  await pool.query("insert into merchants(id,name,zone_id) values($1::uuid,'Resto 1',$2::uuid) on conflict do nothing", [merchantId, zoneId])
  await pool.query("insert into drivers(id,name,zone_id) values($1::uuid,'Livreur 1',$2::uuid) on conflict do nothing", [driverId, zoneId])
  await pool.query("insert into merchants(id,name,zone_id) values($1::uuid,'Resto 2',$2::uuid) on conflict do nothing", [merchant2Id, zoneId])
  await pool.query("insert into drivers(id,name,zone_id) values($1::uuid,'Livreur 2',$2::uuid) on conflict do nothing", [driver2Id, zoneId])
})
beforeEach(async () => { if (isolated) await setGoLive(GO_LIVE) })
afterEach(async () => {
  if (!isolated) return
  await pool.query('rollback').catch(() => undefined)
  // driver_connect_accounts / driver_payout_observations sont partagées avec settlement-guards.integration.test.ts (fichier exécuté en
  // parallèle) : on n'y supprime que les lignes de CE fichier ; le reste est tronqué.
  await pool.query(`truncate table ${SETTLEMENT_TABLES.filter(t => t !== 'driver_connect_accounts' && t !== 'driver_payout_observations').join(', ')} cascade`)
  await pool.query('delete from driver_payout_observations where driver_id = any($1::uuid[])', [[driverId, driver2Id]])
  await pool.query('delete from driver_connect_accounts where driver_id = any($1::uuid[])', [[driverId, driver2Id]])
  await deleteTestOrders(pool, orders.splice(0))
})
afterAll(async () => {
  if (!isolated) return
  await setGoLive('null')
  await releaseSingleton?.()
  await pool.query('delete from drivers where id = any($1::uuid[])', [[driverId, driver2Id]])
  await pool.query('delete from merchants where id = any($1::uuid[])', [[merchantId, merchant2Id]])
})

describe.skipIf(!isolated)('fees and ledger arithmetic', () => {
  it('computes the fee per line with floor, never on the total (401/475/909 at 2000 bps)', async () => {
    const l = await ledger({ earnings: [401, 475, 909] })
    const lines = await pool.query<{ driver_earning_cents: string; fee_cents: string; net_cents: string }>('select driver_earning_cents, fee_cents, net_cents from settlement_lines where statement_id=$1 order by driver_earning_cents', [l.statement])
    expect(lines.rows.map(r => [Number(r.driver_earning_cents), Number(r.fee_cents), Number(r.net_cents)])).toEqual([[401, 80, 321], [475, 95, 380], [909, 181, 728]])
    expect(l.fee).toBe(356)
    expect(Math.floor((401 + 475 + 909) * 0.2)).toBe(357) // le calcul sur le total divergerait : la règle est par ligne
    expect(l.due).toBe(1785 - 356)
  })

  it.each([{ feeCents: 79 }, { feeCents: 81 }, { feeCents: 0 }])('rejects a line whose fee is not floor(earning*bps/10000) (%j)', async ({ feeCents }) => {
    const l = await ledger({ earnings: [475] })
    const o = await mkOrder({ earning: 401 })
    await expectRejects(insertLine(viaPool, l, o, { feeCents }), /violates check constraint "settlement_lines_(check|fee_cents_check)"/)
  })

  it('rejects statement totals that differ from the sum of its lines at COMMIT', async () => {
    const o = await mkOrder({})
    const ids = { period: randomUUID(), settlement: randomUUID(), statement: randomUUID(), driver: driverId, merchant: merchantId }
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query("insert into settlement_periods(id,period_start,period_end) values($1::uuid, now() - interval '10 days', now() - interval '3 days')", [ids.period])
      await client.query('insert into merchant_settlements(id,period_id,merchant_id,amount_cents) values($1::uuid,$2::uuid,$3::uuid,475)', [ids.settlement, ids.period, merchantId])
      await client.query('insert into settlement_statements(id,period_id,driver_id,merchant_id,merchant_settlement_id,gross_cents,fee_cents,due_cents) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,475,96,379)', [ids.statement, ids.period, driverId, merchantId, ids.settlement])
      await insertLine(viaClient(client), ids, o)
      await expect(client.query('commit')).rejects.toThrow(/ne correspondent pas/)
    } finally {
      await client.query('rollback').catch(() => undefined)
      client.release()
    }
  })

  it('rejects a merchant settlement amount that differs from the sum of its lines at COMMIT, accepts the exact one', async () => {
    const o = await mkOrder({})
    const ids = { period: randomUUID(), settlement: randomUUID(), statement: randomUUID(), driver: driverId, merchant: merchantId }
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query("insert into settlement_periods(id,period_start,period_end) values($1::uuid, now() - interval '10 days', now() - interval '3 days')", [ids.period])
      await client.query('insert into merchant_settlements(id,period_id,merchant_id,amount_cents) values($1::uuid,$2::uuid,$3::uuid,476)', [ids.settlement, ids.period, merchantId])
      await client.query('insert into settlement_statements(id,period_id,driver_id,merchant_id,merchant_settlement_id,gross_cents,fee_cents,due_cents) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,475,95,380)', [ids.statement, ids.period, driverId, merchantId, ids.settlement])
      await insertLine(viaClient(client), ids, o)
      await expect(client.query('commit')).rejects.toThrow(/règlement restaurant/)
    } finally {
      await client.query('rollback').catch(() => undefined)
      client.release()
    }
    await expect(ledger({ earnings: [475] })).resolves.toBeDefined()
  })

  it('keeps lines append-only and statement identity and amounts immutable', async () => {
    const l = await ledger({})
    await expectRejects(pool.query('update settlement_lines set fee_cents=0 where statement_id=$1', [l.statement]), /append-only/)
    await expectRejects(pool.query('delete from settlement_lines where statement_id=$1', [l.statement]), /append-only/)
    await expectRejects(pool.query('update settlement_statements set gross_cents=gross_cents+1 where id=$1', [l.statement]), /immuables/)
    await expectRejects(pool.query('update settlement_statements set driver_id=$2 where id=$1', [l.statement, driver2Id]), /immuables/)
    // une ligne ajoutée après coup à un statement déjà validé rendrait ses totaux faux : refusée au COMMIT
    await expectRejects(insertLine(viaPool, l, await mkOrder({ earning: 401 })), /ne correspondent pas/)
  })

  it('enforces status paid <=> paid_cents = due_cents and paid_cents <= due_cents', async () => {
    const l = await ledger({})
    await expectRejects(pool.query("update settlement_statements set status='paid' where id=$1", [l.statement]), /paid_status/)
    await expectRejects(pool.query('update settlement_statements set paid_cents=$2 where id=$1', [l.statement, l.due + 1]), /violates check constraint/)
  })
})

describe.skipIf(!isolated)('go-live boundary', () => {
  it('refuses any line when go_live_at is not set', async () => {
    await setGoLive('null')
    await expectRejects(ledger({}), /go_live_at/)
  })

  it('makes go_live_at immutable once set and forbids deleting the singleton', async () => {
    await expectRejects(pool.query('update settlement_settings set go_live_at = now() where id = true'), /immuable/)
    await expectRejects(pool.query('delete from settlement_settings'), /interdite/)
    await expectRejects(pool.query('insert into settlement_settings(id) values (false)'), /settlement_settings_id_check/)
    await pool.query('update settlement_settings set fee_rule_version = fee_rule_version where id = true') // les autres champs restent modifiables
  })

  it('refuses an order created before go_live_at and accepts one created after', async () => {
    await setGoLive("now() - interval '7 days'")
    await expectRejects(ledger({ specs: [{ createdAt: "now() - interval '8 days'" }] }), /antérieure à go_live_at/)
    await expect(ledger({ specs: [{ createdAt: "now() - interval '6 days'" }] })).resolves.toBeDefined()
  })

  it('requires go_live_at to close a period and a matching snapshot, and freezes a closed period', async () => {
    const closedInsert = (snapshot: string, complete = true) => pool.query(
      `insert into settlement_periods(period_start,period_end,status,go_live_at_snapshot${complete ? ',closed_at,debit_date,payrun_at,promise_deadline' : ''})
       values(now() - interval '20 days', now() - interval '13 days','closed',${snapshot}${complete ? ',now(),current_date,now(),current_date' : ''})`)
    await setGoLive('null')
    await expectRejects(closedInsert('null'), /go_live_at défini/)
    await setGoLive(GO_LIVE)
    await expectRejects(closedInsert("now() - interval '199 days'"), /snapshot go_live_at/)
    await expectRejects(closedInsert('(select go_live_at from settlement_settings)', false), /closed_fields_check/)
    await closedInsert('(select go_live_at from settlement_settings)')
    await expectRejects(pool.query("update settlement_periods set period_start = period_start - interval '1 hour' where status='closed'"), /immuables/)
  })
})

describe.skipIf(!isolated)('half-open periods and final order snapshots', () => {
  it('accepts finalized_at = period_start, refuses finalized_at = period_end, refuses overlap, allows adjacency', async () => {
    const s = (await pool.query<{ t: Date }>("select now() - interval '6 days' t")).rows[0]?.t as Date
    const end = new Date(s.getTime() + 86_400_000)
    const o1 = await mkOrder({ completedAt: `'${s.toISOString()}'::timestamptz` })
    const o2 = await mkOrder({ completedAt: `'${end.toISOString()}'::timestamptz` })
    const beforeStart = await mkOrder({ completedAt: `'${new Date(s.getTime() - 1000).toISOString()}'::timestamptz` })
    const ids = { period: randomUUID(), settlement: randomUUID(), statement: randomUUID(), driver: driverId, merchant: merchantId }
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query('insert into settlement_periods(id,period_start,period_end) values($1::uuid,$2::timestamptz,$3::timestamptz)', [ids.period, s, end])
      await client.query('insert into merchant_settlements(id,period_id,merchant_id,amount_cents) values($1::uuid,$2::uuid,$3::uuid,475)', [ids.settlement, ids.period, merchantId])
      await client.query('insert into settlement_statements(id,period_id,driver_id,merchant_id,merchant_settlement_id,gross_cents,fee_cents,due_cents) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,475,95,380)', [ids.statement, ids.period, driverId, merchantId, ids.settlement])
      await insertLine(viaClient(client), ids, o1) // = period_start : inclus
      await client.query('savepoint before_end')
      await expectRejects(insertLine(viaClient(client), ids, o2), /demi-ouverte/) // = period_end : exclu
      await client.query('rollback to savepoint before_end')
      await client.query('savepoint before_start')
      await expectRejects(insertLine(viaClient(client), ids, beforeStart), /demi-ouverte/) // < period_start : exclu
      await client.query('rollback to savepoint before_start')
      await client.query('commit')
    } finally {
      await client.query('rollback').catch(() => undefined)
      client.release()
    }
    await expectRejects(pool.query('insert into settlement_periods(period_start,period_end) values($1::timestamptz,$2::timestamptz)', [new Date(s.getTime() + 3_600_000), new Date(s.getTime() + 2 * 86_400_000)]), /no_overlap/)
    await pool.query('insert into settlement_periods(period_start,period_end) values($1::timestamptz,$2::timestamptz)', [end, new Date(s.getTime() + 2 * 86_400_000)]) // adjacente [b,c)
  })

  it('settles COMPLETED and RETURNED, refuses RETURNING, CANCELLED, RETURNED without event, and a second line per order', async () => {
    const l = await ledger({ specs: [{ status: 'COMPLETED' }, { status: 'RETURNED', earning: 909 }] })
    const finals = await pool.query<{ final_status: string }>('select final_status from settlement_lines where statement_id=$1 order by final_status', [l.statement])
    expect(finals.rows.map(r => r.final_status)).toEqual(['COMPLETED', 'RETURNED'])
    const returning = await mkOrder({ status: 'RETURNING', earning: 401 })
    await expectRejects(insertLine(viaPool, l, returning, { finalStatus: 'RETURNING', finalizedAt: new Date(Date.now() - 5 * 86_400_000) }), /final_status/)
    const cancelled = await mkOrder({ status: 'CANCELLED', earning: 401 })
    await expectRejects(insertLine(viaPool, l, cancelled, { finalStatus: 'CANCELLED', finalizedAt: new Date(Date.now() - 5 * 86_400_000) }), /final_status/)
    const completedOnly = await mkOrder({ status: 'COMPLETED', earning: 400 })
    await expectRejects(insertLine(viaPool, l, completedOnly, { finalStatus: 'RETURNED' }), /commande ne correspond pas/)
    await expectRejects(insertLine(viaPool, l, l.orders[0] as Ord), /order_id/)
  })

  it('requires the RETURNED finalization to equal the persisted order event', async () => {
    const o = await mkOrder({ status: 'RETURNED', earning: 909 })
    const l = await ledger({ earnings: [475], offsetDays: 0 })
    await expectRejects(insertLine(viaPool, l, o, { finalizedAt: new Date(Date.now() - 4.5 * 86_400_000) }), /RETURNED/)
  })

  it.each([
    ['another driver', { driver: driver2Id }],
    ['another merchant', { merchant: merchant2Id }],
  ])('refuses an order of %s', async (_label, spec) => {
    const l = await ledger({ earnings: [475] })
    const o = await mkOrder({ earning: 401, ...spec })
    await expectRejects(insertLine(viaPool, l, o), /commande ne correspond pas/)
  })

  it('refuses invented amounts and a finalized_at that differs from completed_at', async () => {
    const l = await ledger({ earnings: [475] })
    const o = await mkOrder({ earning: 401 })
    await expectRejects(insertLine(viaPool, l, o, { merchantAmount: 402 }), /commande ne correspond pas/)
    await expectRejects(insertLine(viaPool, l, o, { earning: 400, feeCents: 80 }), /commande ne correspond pas/)
    await expectRejects(insertLine(viaPool, l, o, { finalizedAt: new Date(Date.now() - 6 * 86_400_000) }), /COMPLETED doit correspondre/)
  })
})

describe.skipIf(!isolated)('merchant debits', () => {
  it('allows one living and one succeeded attempt per settlement, and a retry after a failure', async () => {
    const l = await ledger({}); await notify(l)
    await notify(l, "now() - interval '3 days'", 2); await notify(l, "now() - interval '3 days'", 3)
    const first = await debit(l, { status: 'processing', attempt: 1 })
    await expectRejects(debit(l, { status: 'creating', attempt: 2 }), /one_living/)
    await pool.query("update debit_attempts set status='failed', failed_at=now(), failure_code='card_declined' where id=$1", [first])
    await debit(l, { status: 'succeeded', attempt: 2 })
    await expectRejects(debit(l, { status: 'succeeded', attempt: 3 }), /one_succeeded/)
  })

  it('forces the debit amount to equal the settlement amount and unique Stripe ids', async () => {
    const l = await ledger({}); await notify(l)
    await expectRejects(debit(l, { amount: l.gross - 1 }), /debit_attempts_amount_fk/)
    await debit(l, { charge: 'py_dup' })
    const other = await ledger({ offsetDays: 30 }); await notify(other)
    await expectRejects(debit(other, { charge: 'py_dup' }), /stripe_charge_id/)
  })

  it('refuses a succeeded debit without Stripe identifiers', async () => {
    const l = await ledger({}); await notify(l)
    await expectRejects(debit(l, { status: 'succeeded', charge: null }), /succeeded_snapshot_check/)
  })

  it.each([
    ['no pre-notification', null, true],
    ['pre-notified the same day', 'now()', true],
    ['pre-notified 1 day before', "now() - interval '1 day'", true],
    ['pre-notified 2 days before', "now() - interval '2 days'", false],
    ['pre-notified 5 days before', "now() - interval '5 days'", false],
  ])('applies the 2 calendar day pre-notification guard: %s', async (_label, at, refused) => {
    const l = await ledger({})
    if (at !== null) await notify(l, at)
    const attempt = debit(l, { status: 'processing' })
    if (refused) await expectRejects(attempt, /pré-notification/)
    else await expect(attempt).resolves.toBeDefined()
  })
})

describe.skipIf(!isolated)('pre-notification gate (migration 0035)', () => {
  const insertSent = (l: Ledger, sentAt: string, debitDate: string, amount = l.gross): Promise<unknown> => pool.query(
    `insert into settlement_pre_notifications(merchant_settlement_id,amount_cents,status,attempt_count,recipient_email,debit_date,iban_last4,mandate_reference,creditor_id,provider,provider_message_id,sent_at)
     values($1::uuid,$2::bigint,'sent',1,'m@example.test',(${debitDate})::date,'1234','M','C','resend','id',(${sentAt})::timestamptz)`, [l.settlement, amount])

  it('refuses a debit BEFORE the date announced in the e-mail even when the notice is old enough', async () => {
    const l = await ledger({})
    await insertSent(l, "now() - interval '3 days'", "((now() at time zone 'Europe/Paris')::date + 1)")
    await expectRejects(debit(l, { status: 'processing' }), /date de prélèvement annoncée/)
  })

  it('refuses a sent pre-notification announcing a debit less than 2 calendar days after sending, and a mismatching amount', async () => {
    const l = await ledger({})
    await expectRejects(insertSent(l, 'now()', "((now() at time zone 'Europe/Paris')::date + 1)"), /notice_check/)
    await expectRejects(insertSent(l, 'now()', "((now() at time zone 'Europe/Paris')::date + 2)", l.gross + 1), /settlement_fk/)
  })

  it('refuses a debit whose mandate is not the pre-notified one (or carries none), and records the pre-notification on the attempt', async () => {
    const l = await ledger({})
    await notify(l, "now() - interval '3 days'")
    const insert = (mandate: string | null): Promise<unknown> => pool.query(
      `insert into debit_attempts(merchant_settlement_id,attempt_no,amount_cents,stripe_account_id,idempotency_key,status,livemode,mandate_reference) values($1::uuid,1,$2::bigint,'acct_test',$3,'creating',false,$4)`, [l.settlement, l.gross, `k-${randomUUID()}`, mandate])
    await expectRejects(insert('OTHER-MANDATE'), /mandat du débit/)
    await expectRejects(insert(null), /mandat du débit/)
    await expect(insert('MANDATE-TEST')).resolves.toBeDefined()
    const row = (await pool.query('select a.pre_notification_id = n.id as linked from debit_attempts a join settlement_pre_notifications n on n.merchant_settlement_id = a.merchant_settlement_id where a.merchant_settlement_id = $1::uuid', [l.settlement])).rows[0]
    expect(row).toMatchObject({ linked: true })
  })

  it('requires a NEW pre-notification for every retry attempt: the first one never covers attempt 2', async () => {
    const l = await ledger({})
    await notify(l, "now() - interval '5 days'")
    await debit(l, { status: 'failed', attempt: 1 })
    await expectRejects(debit(l, { status: 'processing', attempt: 2 }), /pré-notification envoyée pour cette tentative/)
    await notify(l, "now() - interval '3 days'", 2)
    await expect(debit(l, { status: 'processing', attempt: 2 })).resolves.toBeDefined()
  })

  it('accepts the debit once a compliant pre-notification is sent, and mirrors it on the settlement', async () => {
    const l = await ledger({})
    await notify(l, "now() - interval '3 days'")
    const row = (await pool.query("select status, pre_notified_at is not null as notified from merchant_settlements where id = $1::uuid", [l.settlement])).rows[0]
    expect(row).toMatchObject({ status: 'notified', notified: true })
    await expect(debit(l, { status: 'processing' })).resolves.toBeDefined()
  })
})

describe.skipIf(!isolated)('driver pay-runs', () => {
  it('allows a single grouped run per period and driver, several drip runs, and forces scheduled_for = payrun_at', async () => {
    const l = await ledger({})
    await payRun(l, 'grouped')
    await expectRejects(payRun(l, 'grouped'), /one_grouped/)
    await pool.query("update driver_pay_runs set status = 'completed', completed_at = now() where run_kind = 'grouped' and period_id = $1::uuid", [l.period])
    await payRun(l, 'drip', 'now()')
    await expectRejects(payRun(l, 'drip', 'now()'), /one_open/) // un seul pay-run ouvert (pending/running) par livreur et période
    await pool.query("update driver_pay_runs set status = 'completed', completed_at = now() where run_kind = 'drip' and period_id = $1::uuid", [l.period])
    await payRun(l, 'drip', 'now()') // plusieurs lots « drip » successifs une fois le précédent terminé
    const other = await ledger({ driver: driver2Id, offsetDays: 30 })
    await expectRejects(payRun(other, 'grouped', "now() + interval '1 hour'"), /payrun_at/)
    const noPayrun = await ledger({ offsetDays: 60, payrunAt: 'null' })
    await expectRejects(payRun(noPayrun, 'grouped', 'now()'), /payrun_at/)
  })
})

describe.skipIf(!isolated)('driver transfers (D-M, D-N, D-O)', () => {
  it.each(['processing', 'failed', 'creating', 'canceled'])('refuses a transfer from a %s debit (Stripe would accept it: only the domain refuses)', async status => {
    const l = await ledger({}); await notify(l)
    const d = await debit(l, { status, charge: status === 'creating' ? null : 'py_x' })
    const run = await payRun(l)
    await expectRejects(transfer(l, d, run, { charge: 'py_x' }), /débit réussi/)
  })

  it('accepts a transfer from a succeeded debit after payrun_at and keeps paid_cents consistent', async () => {
    const l = await ledger({}); await notify(l)
    const d = await debit(l); const run = await payRun(l)
    await paidTransfer(l, d, run)
    const s = await pool.query<{ paid_cents: string; status: string }>('select paid_cents, status from settlement_statements where id=$1', [l.statement])
    expect(s.rows[0]).toMatchObject({ paid_cents: String(l.due), status: 'paid' })
  })

  it('refuses any transfer before payrun_at (D-N) and accepts it once payrun_at has passed', async () => {
    const early = await ledger({ payrunAt: "now() + interval '1 day'" }); await notify(early)
    const d = await debit(early); const run = await payRun(early)
    await expectRejects(transfer(early, d, run), /avant payrun_at/)
    await pool.query("update settlement_periods set payrun_at = now() - interval '1 minute' where id=$1", [early.period])
    await expect(transfer(early, d, run)).resolves.toBeDefined()
  })

  it('refuses a debit of another settlement, a mismatching source charge and a foreign pay-run', async () => {
    const a = await ledger({}); const b = await ledger({ merchant: merchant2Id, offsetDays: 30 })
    await notify(a); await notify(b)
    const da = await debit(a); const db = await debit(b); const runA = await payRun(a)
    await expectRejects(transfer(a, db, runA), /même règlement/)
    await expectRejects(transfer(a, da, runA, { charge: 'py_other' }), /charge source/)
    const runOtherDriver = await payRun(await ledger({ driver: driver2Id, offsetDays: 60 }))
    await expectRejects(transfer(a, da, runOtherDriver), /même période et au même livreur/)
  })

  it('caps live transfers at the statement due and allows one living transfer per (statement, debit)', async () => {
    const l = await ledger({}); await notify(l)
    const d = await debit(l); const run = await payRun(l)
    await expectRejects(transfer(l, d, run, { amount: l.due + 1 }), /dépassent le dû/)
    const first = await transfer(l, d, run, { amount: l.due - 100, tryNo: 1 })
    await expectRejects(transfer(l, d, run, { amount: 50, tryNo: 2 }), /one_living/)
    await pool.query("update driver_transfers set status='failed', failure_code='x' where id=$1", [first])
    await expectRejects(transfer(l, d, run, { amount: l.due + 1, tryNo: 2 }), /dépassent le dû/)
    await expect(transfer(l, d, run, { amount: l.due, tryNo: 2, key: 'retry-2' })).resolves.toBeDefined()
    await expectRejects(transfer(l, d, run, { amount: 1, tryNo: 3, key: 'retry-3' }), /dépassent le dû|one_living/)
  })

  it('never accepts a funding mode other than source_transaction (no advance)', async () => {
    const l = await ledger({}); await notify(l)
    const d = await debit(l); const run = await payRun(l)
    await expectRejects(transfer(l, d, run, { mode: 'platform_advance' }), /funding_mode/)
  })

  it('keeps restaurants independent: a failed debit blocks only its own statement (D-M)', async () => {
    const ok = await ledger({}); const ko = await ledger({ merchant: merchant2Id, offsetDays: 30 }) // même livreur, deux restaurants
    await notify(ok); await notify(ko)
    const dOk = await debit(ok); const dKo = await debit(ko, { status: 'failed', charge: 'py_failed' })
    const runOk = await payRun(ok); const runKo = await payRun(ko)
    await expectRejects(transfer(ko, dKo, runKo, { charge: 'py_failed' }), /débit réussi/)
    await expect(paidTransfer(ok, dOk, runOk)).resolves.toBeDefined()
  })

  it('requires paid_cents to equal the sum of succeeded transfers at COMMIT (both directions)', async () => {
    const l = await ledger({}); await notify(l)
    const d = await debit(l); const run = await payRun(l)
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query("insert into driver_transfers(id,statement_id,pay_run_id,debit_attempt_id,stripe_charge_id,amount_cents,try_no,idempotency_key,status,stripe_transfer_id,succeeded_at,livemode) select gen_random_uuid(),$1::uuid,$2::uuid,$3::uuid,stripe_charge_id,$4::bigint,1,'k1','succeeded','tr_1',now(),livemode from debit_attempts where id=$3::uuid", [l.statement, run, d, l.due])
      await expect(client.query('commit')).rejects.toThrow(/paid_cents/) // transfert réussi sans mise à jour du statement
    } finally { await client.query('rollback').catch(() => undefined); client.release() }
    await expectRejects(pool.query("update settlement_statements set paid_cents = 10, status = 'partial' where id=$1", [l.statement]), /paid_cents/) // paid_cents sans transfert
  })

  it('refuses inconsistent Stripe modes and a succeeded transfer without transfer id', async () => {
    const l = await ledger({}); await notify(l)
    const d = await debit(l); const run = await payRun(l)
    await expectRejects(transfer(l, d, run, { livemode: true }), /mode Stripe/)
    await expectRejects(pool.query("insert into driver_transfers(statement_id,pay_run_id,debit_attempt_id,stripe_charge_id,amount_cents,try_no,idempotency_key,status,succeeded_at,livemode) select $1::uuid,$2::uuid,$3::uuid,stripe_charge_id,10,1,'nid','succeeded',now(),livemode from debit_attempts where id=$3::uuid", [l.statement, run, d]), /succeeded_snapshot_check/)
  })
})

describe.skipIf(!isolated)('reversals (categories B and C only, D-O)', () => {
  async function succeededTransfer(offsetDays = 0): Promise<{ id: string; l: Ledger }> {
    const l = await ledger({ offsetDays }); await notify(l)
    const d = await debit(l); const run = await payRun(l)
    return { id: await paidTransfer(l, d, run), l }
  }
  interface RevOver { category: string; amount: number; reason: string; status: string; approvedBy: string | null; requestedBy: string; livemode: boolean }
  const insertReversal = (transferId: string, o: Partial<RevOver> = {}) =>
    pool.query("insert into driver_transfer_reversals(driver_transfer_id,category,reason_code,amount_cents,reason,decision_reference,requested_by,approved_by,approved_at,status,idempotency_key,livemode) values($1::uuid,$2,$3,$4::bigint,$5,$6,$7::uuid,$8::uuid,case when $8::uuid is not null then now() end,$9,$10,$11::boolean)",
      [transferId, o.category ?? 'driver_fault', (o.category ?? 'driver_fault') === 'locadely_error' ? 'other_locadely_error' : 'other_validated_decision', o.amount ?? 100, o.reason ?? 'vol constaté', `DEC-${randomUUID()}`, o.requestedBy ?? merchantId, o.approvedBy ?? null, o.status ?? 'pending_approval', randomUUID(), o.livemode ?? false])

  it.each(['restaurant_default', 'restaurant_dispute', 'sepa_return', 'other'])('has no category for a restaurant default or dispute: %s is refused', async category => {
    const { id } = await succeededTransfer()
    await expectRejects(insertReversal(id, { category }), /category/)
  })

  it('accepts driver_fault and locadely_error with a distinct approver, within the transfer amount', async () => {
    const { id, l } = await succeededTransfer()
    await insertReversal(id, { category: 'driver_fault', amount: 100, status: 'approved', approvedBy: driverId })
    await insertReversal(id, { category: 'locadely_error', amount: l.due - 100, status: 'approved', approvedBy: driverId })
    await expectRejects(insertReversal(id, { amount: 1 }), /dépassent le montant/)
  })

  it('requires an approver from the approved status, distinct from the requester, and a non blank reason', async () => {
    const { id } = await succeededTransfer()
    await expectRejects(insertReversal(id, { status: 'approved', approvedBy: null }), /approval_check/)
    await expectRejects(insertReversal(id, { status: 'approved', approvedBy: merchantId, requestedBy: merchantId }), /approval_check/)
    await expectRejects(insertReversal(id, { reason: '   ' }), /reason/)
  })

  it('refuses a reversal of a transfer that did not succeed and mismatching Stripe modes', async () => {
    const l = await ledger({}); await notify(l)
    const d = await debit(l); const run = await payRun(l)
    const pending = await transfer(l, d, run, { amount: 10 })
    await expectRejects(insertReversal(pending), /transfert réussi/)
    const { id } = await succeededTransfer(30)
    await expectRejects(insertReversal(id, { livemode: true }), /mode Stripe/)
  })
})

describe.skipIf(!isolated)('driver Connect accounts, payouts, receivables and reconciliation', () => {
  const account = (driver: string, acct: string, type: string, dashboard?: string) => pool.query(
    `insert into driver_connect_accounts(driver_id,stripe_account_id,entity_type,livemode${dashboard ? ',dashboard' : ''}) values($1::uuid,$2,$3,false${dashboard ? `,'${dashboard}'` : ''})`, [driver, acct, type])

  it('supports individual and company drivers, one account per driver, unique Stripe accounts', async () => {
    await account(driverId, 'acct_ind', 'individual')
    await account(driver2Id, 'acct_co', 'company')
    await expectRejects(account(driverId, 'acct_other', 'individual'), /driver_connect_accounts_pkey/)
    await expectRejects(account(driver2Id, 'acct_ind', 'company'), /stripe_account_id|pkey/)
    await pool.query('delete from driver_connect_accounts where driver_id = any($1::uuid[])', [[driverId, driver2Id]])
    await expectRejects(account(driverId, 'acct_x', 'sole_trader'), /entity_type/)
    await expectRejects(account(driverId, 'acct_x', 'individual', 'full'), /dashboard/)
  })

  it('links payout observations to the matching driver account only', async () => {
    await account(driverId, 'acct_ind', 'individual')
    await pool.query("insert into driver_payout_observations(driver_id,stripe_account_id,stripe_payout_id,amount_cents,status,automatic,livemode) values($1::uuid,'acct_ind','po_1',100,'paid',true,false)", [driverId])
    await expectRejects(pool.query("insert into driver_payout_observations(driver_id,stripe_account_id,stripe_payout_id,amount_cents,status,automatic,livemode) values($1::uuid,'acct_zzz','po_2',100,'paid',true,false)", [driverId]), /account_fk/)
    await expectRejects(pool.query("insert into driver_payout_observations(driver_id,stripe_account_id,stripe_payout_id,amount_cents,status,automatic,livemode) values($1::uuid,'acct_ind','po_1',100,'paid',true,false)", [driverId]), /stripe_payout_id/)
  })

  it('stores receivables and reconciliation findings with positive amounts and valid kinds', async () => {
    await expectRejects(pool.query("insert into merchant_receivables(merchant_id,kind,amount_cents) values($1::uuid,'sepa_dispute',0)", [merchantId]), /amount_cents/)
    await expectRejects(pool.query("insert into merchant_receivables(merchant_id,kind,amount_cents) values($1::uuid,'driver_advance',10)", [merchantId]), /kind/)
    await pool.query("insert into merchant_receivables(merchant_id,kind,amount_cents,stripe_dispute_id) values($1::uuid,'sepa_dispute_fee',1500,'dp_1')", [merchantId])
    await expectRejects(pool.query("insert into merchant_receivables(merchant_id,kind,amount_cents,stripe_dispute_id) values($1::uuid,'sepa_dispute',10,'dp_1')", [merchantId]), /stripe_dispute_id/)
    const run = await pool.query<{ id: string }>("insert into settlement_reconciliation_runs(status) values('running') returning id")
    await pool.query("insert into settlement_reconciliation_findings(run_id,kind,ref_type,ref_id,expected_cents,actual_cents) values($1::uuid,'amount_mismatch','driver_transfer','tr_1',100,90)", [run.rows[0]?.id])
  })
})

describe.skipIf(!isolated)('Data API exposure and migration hygiene', () => {
  it('enables RLS and grants nothing to anon/authenticated on every settlement table', async () => {
    const rows = await pool.query<{ relname: string; relrowsecurity: boolean; anon: boolean; authenticated: boolean }>(
      `select c.relname, c.relrowsecurity, has_table_privilege('anon', c.oid, 'select,insert,update,delete') anon, has_table_privilege('authenticated', c.oid, 'select,insert,update,delete') authenticated
       from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = any($1::text[])`, [ALL_TABLES])
    expect(rows.rows.map(r => r.relname).sort()).toEqual([...ALL_TABLES].sort())
    expect(rows.rows.every(r => r.relrowsecurity && !r.anon && !r.authenticated)).toBe(true)
    const policies = await pool.query("select 1 from pg_policies where schemaname='public' and tablename = any($1::text[])", [ALL_TABLES])
    expect(policies.rowCount).toBe(0)
  })

  it('revokes function execution from anon, authenticated and PUBLIC on every settlement trigger function', async () => {
    const fns = await pool.query<{ proname: string; anon: boolean; authenticated: boolean; pub: boolean }>(
      `select p.proname, has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') authenticated,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') pub
       from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'guard\\_%' or p.proname like 'assert\\_%') and p.proname ~ '(settlement|debit|pay_run|driver_transfer|statement)'`)
    expect(fns.rows.length).toBeGreaterThanOrEqual(12)
    expect(fns.rows.filter(r => r.anon || r.authenticated || r.pub).map(r => r.proname)).toEqual([])
  })

  it('does not install extensions in the migrations (the period exclusion constraint needs none)', () => {
    const dir = join(process.cwd(), '..', '..', 'supabase', 'migrations')
    const files = readdirSync(dir).filter(f => /^003[0-3]_/.test(f))
    expect(files).toHaveLength(4)
    for (const f of files) expect(readFileSync(join(dir, f), 'utf8')).not.toMatch(/create\s+extension/i)
  })
})
