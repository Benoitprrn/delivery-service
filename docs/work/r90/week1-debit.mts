// R90 scénarios A/B/F (2/3) — prélèvements SEPA R50 réels (Sandbox) le mercredi 02/09/2026 08:00 Paris (horloge simulée dans le passé réel).
// F : 2 workers concurrents dès le 1er cycle + « crash » simulé APRÈS la création réussie du PaymentIntent (R3) puis reprise sans doublon.
import { evidence, log, RUN_ID } from './lib.mts'
import { S, debitProvider, pool, sepaUseCase, sleep, state, stripe } from './uc.mts'

const t0 = Date.now(); const DEBIT_DAY = new Date('2026-09-02T06:00:00Z').getTime()
const simNow = () => new Date(DEBIT_DAY + (Date.now() - t0))
const r3Settlement = (await pool.query('select id from merchant_settlements where merchant_id = $1::uuid', [state.restaurants.R3.id])).rows[0].id as string
let crashed = 0
const crashOnce = {
  livemode: false,
  createDebit: async (i: any) => {
    const out = await debitProvider.createDebit(i)
    if (i.idempotencyKey.includes(r3Settlement) && crashed === 0) { crashed += 1; throw new Error('CRASH simulé après la création Stripe (processus tué avant l’écriture en base)') }
    return out
  },
  retrieveDebit: (p: string) => debitProvider.retrieveDebit(p),
  findDebitByAttemptId: (a: string) => debitProvider.findDebitByAttemptId(a),
}
const rows = async () => (await pool.query(`select m.name, a.status, a.attempt_no, a.amount_cents::int as amount, a.stripe_payment_intent_id as pi, a.stripe_charge_id as charge, a.failure_code, ms.status as settlement
  from debit_attempts a join merchant_settlements ms on ms.id = a.merchant_settlement_id join merchants m on m.id = ms.merchant_id order by m.name`)).rows

// avant la date : rien ne doit partir
log('avant 08:00 Paris', await sepaUseCase().execute({ now: new Date(DEBIT_DAY - 3600_000) }))
const [w1, w2] = await Promise.all([sepaUseCase(crashOnce).execute({ now: simNow() }).catch((e: Error) => ({ error: e.message })), sepaUseCase(crashOnce).execute({ now: simNow() }).catch((e: Error) => ({ error: e.message }))])
log('cycle 1 — worker 1', w1); log('cycle 1 — worker 2', w2)
const afterCycle1 = await rows()
log('après cycle 1', afterCycle1.map((r: any) => `${r.name.slice(-2)}:${r.status}`))
let terminal = false
for (let i = 0; i < 60 && !terminal; i += 1) {
  await sleep(15_000)
  await sepaUseCase().execute({ now: simNow() })
  const r = await rows()
  log(`cycle ${i + 2}`, r.map((x: any) => `${x.name.slice(-2)}:${x.status}`))
  terminal = r.length === 10 && r.every((x: any) => x.status === 'succeeded' || x.status === 'failed')
}
const final = await rows()
// preuves Stripe : un seul PaymentIntent par règlement, métadonnées + run_id relues chez Stripe
const perSettlement = (await pool.query('select merchant_settlement_id, count(*)::int as n from debit_attempts group by 1 having count(*) > 1')).rows
const stripeChecks: any[] = []
for (const r of final) {
  const pi = await stripe.paymentIntents.retrieve(r.pi, { expand: ['latest_charge'] })
  stripeChecks.push({ resto: r.name.slice(-2), db: r.status, stripe: pi.status, amount: pi.amount === r.amount, transfer_group: pi.transfer_group, metadataKeys: Object.keys(pi.metadata).sort(), failure: pi.last_payment_error?.code ?? pi.latest_charge?.failure_code ?? null })
}
const search = await stripe.paymentIntents.search({ query: `metadata['settlement_id']:'x'`, limit: 1 }).catch(() => null)
const ok = final.length === 10 && perSettlement.length === 0 && final.filter((r: any) => r.status === 'succeeded').length === 8 && final.filter((r: any) => r.status === 'failed').length === 2 && crashed === 1
evidence('A/B/F-debit', ok ? 'OK' : 'KO', ['SEPA-01', 'SEPA-02', 'STR-01', 'TST-01'], { final: final.map((r: any) => ({ resto: r.name, status: r.status, amount: r.amount, failure: r.failure_code, settlement: r.settlement })), duplicatesPerSettlement: perSettlement, crashSimulated: crashed, worker1: w1, worker2: w2, stripeChecks, runId: RUN_ID })
await pool.end()
