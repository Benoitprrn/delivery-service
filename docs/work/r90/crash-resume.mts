// R90 scénario F2 — reprise après crash : (1) reversal Stripe créée puis « crash » avant l'écriture en base -> reprise sans doublon (clé d'idempotence `reversal:<id>`) ;
// (2) événement webhook laissé `processing` par un worker mort (bail expiré) -> repris par le worker de l'API R90.
import fs from 'node:fs'
import { CREDENTIALS_FILE, api, evidence, log, postSignedWebhook, signIn } from './lib.mts'
import { S, pool, sleep, state, stripe } from './uc.mts'

const creds = Object.fromEntries(fs.readFileSync(CREDENTIALS_FILE, 'utf8').trim().split('\n').map((l) => l.split(' ') as [string, string]))
const a1 = await signIn('admin.dev@locadely.test', creds['admin.dev@locadely.test']!), a2 = await signIn('admin2.dev@locadely.test', creds['admin2.dev@locadely.test']!)
const t = (await pool.query(`select t.id, t.stripe_transfer_id as stripe, t.amount_cents::int as amount from driver_transfers t join settlement_statements st on st.id = t.statement_id where t.status = 'succeeded' and st.driver_id = $1::uuid order by t.amount_cents limit 1`, [state.drivers.D2.id])).rows[0]
const req = await api('POST', '/api/v1/admin/reversals', a1, { driverTransferId: t.id, category: 'driver_fault', reasonCode: 'other_validated_decision', reason: 'Décision validée (test crash R90)', decisionReference: 'R90-F2-1', amountCents: 100 })
const id = req.json.reversalId as string
await api('POST', `/api/v1/admin/reversals/${id}/approve`, a2)
const real = new S.StripeDriverReversalProvider(stripe, false)
let crashed = 0
const crashAfterCreate = new Proxy(real, { get(target: any, prop) { if (prop === 'createReversal') return async (i: any) => { const out = await target.createReversal(i); if (crashed === 0) { crashed += 1; throw new Error('CRASH simulé après la création Stripe de la reversal') } return out }; const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v } })
const repo = new S.PostgresDriverReversalRepository(pool)
const silent = { debug() {}, info() {}, warn: (o: unknown, m: string) => log('WARN ' + m, o), error: (o: unknown, m: string) => log('ERROR ' + m, o) }
const w1 = await new S.ExecuteDriverReversalsUseCase(repo, crashAfterCreate, silent, { retrySeconds: 1 }).execute({ now: new Date() })
const mid = (await pool.query('select status, stripe_reversal_id from driver_transfer_reversals where id = $1::uuid', [id])).rows[0]
log('après crash', { worker1: w1, mid })
let w2: any = null
for (let i = 0; i < 6; i += 1) { await sleep(3000); w2 = await new S.ExecuteDriverReversalsUseCase(repo, real, silent, { retrySeconds: 1 }).execute({ now: new Date() }); const s = (await pool.query('select status from driver_transfer_reversals where id = $1::uuid', [id])).rows[0].status; if (s === 'succeeded') break }
const fin = (await pool.query('select status, reversed_cents::int as reversed, stripe_reversal_id from driver_transfer_reversals where id = $1::uuid', [id])).rows[0]
const stripeRevs = (await stripe.transfers.listReversals(t.stripe, { limit: 10 })).data
log('après reprise', { w2, fin, stripeReversals: stripeRevs.map((r: any) => r.amount) })
const revOk = fin.status === 'succeeded' && fin.reversed === 100 && stripeRevs.length === 1 && stripeRevs[0].id === fin.stripe_reversal_id && crashed === 1
evidence('F2-reversal-crash-resume', revOk ? 'OK' : 'KO', ['REV-01', 'CFG-03'], { crashed, mid, final: fin, stripeReversalAmounts: stripeRevs.map((r: any) => r.amount) })

// (2) webhook laissé `processing` par un worker mort
const r12 = (await pool.query("select a.stripe_payment_intent_id as pi, a.stripe_charge_id as charge from debit_attempts a join merchant_settlements ms on ms.id = a.merchant_settlement_id where ms.merchant_id = $1::uuid", [state.restaurants.R12.id])).rows[0]
const eid = `evt_r90_f2_${Date.now().toString(36)}`
const http = await postSignedWebhook({ id: eid, type: 'payment_intent.succeeded', data: { object: { id: r12.pi, object: 'payment_intent', latest_charge: r12.charge } } })
const forced = await pool.query("update settlement_stripe_events set status = 'processing', claim_token = gen_random_uuid(), lease_expires_at = now() - interval '2 minutes', attempt_count = attempt_count + 1 where event_id = $1 and status = 'pending' returning event_id", [eid])
log('événement laissé processing (bail expiré)', { http, forced: forced.rowCount })
let ev: any = null
for (let i = 0; i < 40; i += 1) { await sleep(5000); ev = (await pool.query('select status, attempt_count from settlement_stripe_events where event_id = $1', [eid])).rows[0]; if (ev?.status === 'processed') break }
log('événement après reprise', ev)
evidence('F2-webhook-lease-resume', ev?.status === 'processed' && forced.rowCount === 1 ? 'OK' : (forced.rowCount === 0 ? 'INFO' : 'KO'), ['WHK-01', 'CFG-03'], { http, forcedProcessing: forced.rowCount, final: ev, note: forced.rowCount === 0 ? 'le worker avait déjà pris l’événement avant la simulation de crash' : 'bail expiré -> repris' })
await pool.end()
