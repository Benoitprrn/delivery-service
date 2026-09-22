// R90 F2b — événement webhook laissé `processing` avec bail expiré (worker mort) : inséré tel quel dans le journal (état laissé par un crash), repris par le worker de l'API R90.
import { evidence, log } from './lib.mts'
import { pool, sleep, state } from './uc.mts'
const r12 = (await pool.query("select a.stripe_payment_intent_id as pi, a.stripe_charge_id as charge from debit_attempts a join merchant_settlements ms on ms.id = a.merchant_settlement_id where ms.merchant_id = $1::uuid", [state.restaurants.R12.id])).rows[0]
const eid = `evt_r90_lease_${Date.now().toString(36)}`
await pool.query("insert into settlement_stripe_events(event_id, event_type, object_id, payment_intent_id, charge_id, status, attempt_count, claim_token, lease_expires_at) values($1,'payment_intent.succeeded',$2,$2,$3,'processing',1,gen_random_uuid(), now() - interval '3 minutes')", [eid, r12.pi, r12.charge])
let ev: any = null
for (let i = 0; i < 60; i += 1) { await sleep(5000); ev = (await pool.query('select status, attempt_count, claim_token is null as claim_cleared from settlement_stripe_events where event_id = $1', [eid])).rows[0]; if (ev.status === 'processed') break }
log('événement après reprise', ev)
evidence('F2-webhook-lease-resume-2', ev.status === 'processed' && ev.attempt_count >= 2 ? 'OK' : 'KO', ['WHK-01', 'CFG-03'], { final: ev, note: 'événement `processing` à bail expiré, inséré directement dans le journal opérationnel (pas une écriture financière) puis repris par le worker de l’API' })
await pool.end()
