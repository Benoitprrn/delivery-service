// R90 CFG-03 — DEUX PROCESSUS distincts qui exécutent en même temps le worker de reversals sur les mêmes demandes approuvées : aucun doublon (baux + `for update skip locked` + clé d'idempotence).
import fs from 'node:fs'
import { CREDENTIALS_FILE, api, evidence, log, signIn } from './lib.mts'
import { S, pool, sleep, state, stripe } from './uc.mts'
const mode = process.argv[2]
const silent = { debug() {}, info() {}, warn: (o: unknown, m: string) => log('WARN ' + m, o), error: (o: unknown, m: string) => log('ERROR ' + m, o) }
if (mode === 'prepare') {
  const creds = Object.fromEntries(fs.readFileSync(CREDENTIALS_FILE, 'utf8').trim().split('\n').map((l) => l.split(' ') as [string, string]))
  const a1 = await signIn('admin.dev@locadely.test', creds['admin.dev@locadely.test']!), a2 = await signIn('admin2.dev@locadely.test', creds['admin2.dev@locadely.test']!)
  const ts = (await pool.query(`select t.id from driver_transfers t join settlement_statements st on st.id = t.statement_id where t.status = 'succeeded' and st.driver_id = $1::uuid and not exists (select 1 from driver_transfer_reversals r where r.driver_transfer_id = t.id) order by t.amount_cents limit 8`, [state.drivers.D2.id])).rows
  for (const [i, t] of ts.entries()) {
    const r = await api('POST', '/api/v1/admin/reversals', a1, { driverTransferId: t.id, category: 'locadely_error', reasonCode: 'wrong_amount', reason: 'Erreur de montant (test 2 processus R90)', decisionReference: `R90-P2-${i}`, amountCents: 50 })
    await api('POST', `/api/v1/admin/reversals/${r.json.reversalId}/approve`, a2)
  }
  log('demandes approuvées', ts.length)
} else if (mode === 'run') {
  const uc = new S.ExecuteDriverReversalsUseCase(new S.PostgresDriverReversalRepository(pool), new S.StripeDriverReversalProvider(stripe, false), silent, { retrySeconds: 2, batchSize: 3 })
  const sums = { claimed: 0, succeeded: 0 }
  for (let i = 0; i < 6; i += 1) { const r = await uc.execute({ now: new Date() }); sums.claimed += r.claimed; sums.succeeded += r.succeeded; await sleep(1500) }
  console.log(`PROCESS ${process.pid} ${JSON.stringify(sums)}`)
} else {
  const rows = (await pool.query("select status, stripe_reversal_id from driver_transfer_reversals where decision_reference like 'R90-P2-%'")).rows
  const ids = rows.map((r: any) => r.stripe_reversal_id).filter(Boolean)
  const perTransfer: number[] = []
  for (const r of (await pool.query("select t.stripe_transfer_id from driver_transfer_reversals r join driver_transfers t on t.id = r.driver_transfer_id where r.decision_reference like 'R90-P2-%'")).rows) perTransfer.push((await stripe.transfers.listReversals(r.stripe_transfer_id, { limit: 10 })).data.length)
  const ok = rows.length >= 6 && rows.every((r: any) => r.status === 'succeeded') && new Set(ids).size === ids.length && perTransfer.every((n) => n === 1)
  evidence('CFG-03-two-processes', ok ? 'OK' : 'KO', ['CFG-03'], { reversals: rows.length, succeeded: rows.filter((r: any) => r.status === 'succeeded').length, distinctStripeIds: new Set(ids).size, reversalsPerTransfer: perTransfer })
}
await pool.end()
