// R90 scénario C2 — litige SEPA APRÈS le paiement du livreur. Semaine 2 simulée (31/08 → 06/09, clôture lundi 07/09 00:05 Paris, débit mercredi 09/09, payrun_at 18/09).
// Le pay-run est lancé DÈS que le SEPA du restaurant litigieux (R11) réussit, avant l'arrivée du litige. Ensuite : webhook signé réel -> incident + créance restaurant, AUCUN reversal livreur, statements payés intacts.
import fs from 'node:fs'
import { REPO, RUN_ID, evidence, guardStripeId, log, postSignedWebhook, r90Metadata } from './lib.mts'
import { S, closeUseCase, debitProvider, payments, payoutUseCase, pool, preNotifier, sepaUseCase, sleep, state, stripe } from './uc.mts'

const zoneId = '11111111-1111-1111-1111-111111111111'
const IBAN = { disputed: 'AT591904300235473203', success: 'AT611904300234573201' }
const restos = [{ slot: 'R11', n: 11, iban: IBAN.disputed, name: 'R90 Resto 11' }, { slot: 'R12', n: 12, iban: IBAN.success, name: 'R90 Resto 12' }]
for (const r of restos) {
  const id = `90000000-0000-4000-8000-00000000001${r.n - 10}`
  const account = await stripe.v2.core.accounts.create({ configuration: { customer: {} }, metadata: r90Metadata({ role: 'restaurant', slot: r.slot, week: '2' }) }); guardStripeId(account.id)
  const si = await stripe.setupIntents.create({ customer_account: account.id, payment_method_types: ['sepa_debit'], usage: 'off_session', confirm: true,
    payment_method_data: { type: 'sepa_debit', sepa_debit: { iban: r.iban }, billing_details: { name: r.name, email: `r90-resto-${r.n}@example.com` } },
    mandate_data: { customer_acceptance: { type: 'online', online: { ip_address: '127.0.0.1', user_agent: 'r90-harness' } } }, metadata: r90Metadata({ slot: r.slot }) })
  const pm = await stripe.paymentMethods.retrieve(si.payment_method); const mandate = await stripe.mandates.retrieve(si.mandate)
  await pool.query('insert into merchants(id,name,zone_id) values($1::uuid,$2,$3::uuid) on conflict do nothing', [id, r.name, zoneId])
  await pool.query('insert into merchant_payment_profiles(merchant_id, stripe_account_id) values($1::uuid,$2)', [id, account.id])
  await pool.query(`insert into merchant_payment_methods(merchant_id, stripe_setup_intent_id, stripe_payment_method_id, stripe_mandate_id, status, last4, country, mandate_reference, activated_at) values($1::uuid,$2,$3,$4,'active',$5,'AT',$6,now())`, [id, si.id, pm.id, mandate.id, pm.sepa_debit?.last4, mandate.payment_method_details?.sepa_debit?.reference])
  state.restaurants[r.slot] = { id, name: r.name, behaviour: r.slot === 'R11' ? 'succès puis litige (semaine 2)' : 'succès (semaine 2)', account: account.id, paymentMethod: pm.id, mandate: mandate.id }
}
fs.writeFileSync(`${REPO}/docs/work/r90/evidence/state-${RUN_ID}.json`, JSON.stringify(state, null, 1))
const orders: Array<[string, string, number]> = [['D1', 'R11', 2400], ['D3', 'R11', 3100], ['D1', 'R12', 2800]]
let i = 0
for (const [d, r, dist] of orders) {
  const created = new Date(Date.UTC(2026, 7, 31, 8 + i, 5)); const completed = new Date(created.getTime() + 26 * 3600_000)
  const ins = await pool.query(`insert into orders(id,merchant_id,driver_id,zone_id,status,customer_name,customer_phone,pickup_address,pickup_lat,pickup_lng,delivery_address,delivery_lat,delivery_lng,distance_m,duration_s,driver_earning_cents,created_at,completed_at)
    values(gen_random_uuid(),$1::uuid,$2::uuid,$3::uuid,'COMPLETED','Client R90','0600000000','P',46.2,5.2,'D',46.21,5.21,$4::int,900,0,$5,$6) returning id`, [state.restaurants[r].id, state.drivers[d].id, zoneId, dist, created, completed])
  await pool.query('update orders set driver_earning_cents = price_cents where id = $1::uuid', [ins.rows[0].id]); i += 1
}
const closed = await closeUseCase().execute({ now: new Date('2026-09-06T22:05:00Z') })
log('clôture semaine 2', closed.map((c: any) => ({ monday: c.closingMonday, debit: c.debitDate, payrun: c.payrunAtUtc, settlements: c.merchantSettlements, statements: c.statements })))
log('pré-notifications', await preNotifier().execute({ now: new Date('2026-09-06T22:05:00Z') }))
const t0 = Date.now(); const D = new Date('2026-09-09T06:00:00Z').getTime(); const simNow = () => new Date(D + (Date.now() - t0))
log('débit', await sepaUseCase().execute({ now: simNow() }))
const settle11 = (await pool.query('select id from merchant_settlements ms where merchant_id = $1::uuid', [state.restaurants.R11.id])).rows[0].id
const attempt = async () => (await pool.query('select status, stripe_payment_intent_id as pi, stripe_charge_id as charge from debit_attempts where merchant_settlement_id = $1::uuid', [settle11])).rows[0]
let a = await attempt()
for (let k = 0; k < 40 && a.status !== 'succeeded'; k += 1) { await sleep(4000); await sepaUseCase().execute({ now: simNow() }); a = await attempt() }
const succeededAt = new Date()
log('R11 SEPA réussi (avant tout litige ?)', { status: a.status, disputedNow: (await stripe.charges.retrieve(a.charge)).disputed })
// pay-run IMMÉDIAT à payrun_at (18/09)
const payrunAt = closed.find((c: any) => c.payrunAtUtc)?.payrunAtUtc
const payout = await payoutUseCase().execute({ now: new Date(payrunAt) })
const r11Transfers = (await pool.query("select t.status, t.amount_cents::int as amount from driver_transfers t join settlement_statements st on st.id = t.statement_id where st.merchant_id = $1::uuid", [state.restaurants.R11.id])).rows
log('pay-run', { payout, r11Transfers })
const paidBeforeDispute = r11Transfers.length === 2 && r11Transfers.every((t: any) => t.status === 'succeeded')
// attente du litige réel
let dispute: any = null
for (let k = 0; k < 120 && !dispute; k += 1) { dispute = (await stripe.disputes.list({ charge: a.charge, limit: 1 })).data[0]; if (!dispute) await sleep(5000) }
const chargeInfo = await stripe.charges.retrieve(a.charge)
log('litige apparu', { seconds: Math.round((Date.now() - succeededAt.getTime()) / 1000), status: dispute?.status, chargeCreated: new Date(chargeInfo.created * 1000).toISOString(), disputeCreated: dispute ? new Date(dispute.created * 1000).toISOString() : null })
const before = { reversals: (await pool.query('select count(*)::int n from driver_transfer_reversals')).rows[0].n, receivables: (await pool.query('select count(*)::int n from merchant_receivables')).rows[0].n, incidents: (await pool.query('select count(*)::int n from debit_incidents')).rows[0].n }
const httpStatus = await postSignedWebhook({ id: `evt_r90_c2_${Date.now().toString(36)}`, type: 'charge.dispute.created', data: { object: { id: dispute.id, object: 'dispute', charge: a.charge, payment_intent: a.pi } } })
let after = before
for (let k = 0; k < 40; k += 1) {
  await sleep(5000)
  after = { reversals: (await pool.query('select count(*)::int n from driver_transfer_reversals')).rows[0].n, receivables: (await pool.query('select count(*)::int n from merchant_receivables')).rows[0].n, incidents: (await pool.query('select count(*)::int n from debit_incidents')).rows[0].n }
  if (after.incidents > before.incidents) break
}
const stmts = (await pool.query("select d.name, s.status, s.paid_cents::int as paid, s.due_cents::int as due from settlement_statements s join drivers d on d.id = s.driver_id where s.merchant_id = $1::uuid", [state.restaurants.R11.id])).rows
const driverReceivables = (await pool.query('select count(*)::int n from driver_receivables')).rows[0].n
log('après litige', { httpStatus, before, after, stmts, driverReceivables })
const ok = paidBeforeDispute && httpStatus === 200 && after.incidents === before.incidents + 1 && after.receivables === before.receivables + 1 && after.reversals === before.reversals && stmts.every((s: any) => s.status === 'paid' && s.paid === s.due) && driverReceivables === 0
evidence('C2-dispute-after-payment', ok ? 'OK' : (paidBeforeDispute ? 'KO' : 'INFO'), ['SEPA-05', 'REV-01', 'WHK-01', 'PAY-02'], { paidBeforeDispute, r11Transfers, disputeSecondsAfterSuccess: Math.round((Date.now() - succeededAt.getTime()) / 1000), before, after, statements: stmts, driverReceivables, note: paidBeforeDispute ? 'litige APRÈS paiement : Locadely assume, aucun reversal livreur (D-A/D-O)' : 'le litige est arrivé AVANT le pay-run : variante déjà couverte par le scénario C' })
await pool.end()
