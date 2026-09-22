// R90 scénarios C + F-web + REC — litige SEPA (R8), webhooks SIGNÉS envoyés à la vraie route de l'API R90 (doublons, hors ordre, signature invalide, type inconnu),
// traitement par le worker de l'API (relecture Stripe réelle), puis réconciliation réelle.
import { evidence, log, postSignedWebhook, RUN_ID } from './lib.mts'
import { S, pool, sleep, state, stripe } from './uc.mts'

const r8 = state.restaurants.R8
const row = (await pool.query(`select a.stripe_payment_intent_id as pi, a.stripe_charge_id as charge, ms.id as settlement_id from debit_attempts a join merchant_settlements ms on ms.id = a.merchant_settlement_id where ms.merchant_id = $1::uuid`, [r8.id])).rows[0]
const r9 = (await pool.query(`select a.stripe_payment_intent_id as pi, a.stripe_charge_id as charge from debit_attempts a join merchant_settlements ms on ms.id = a.merchant_settlement_id where ms.merchant_id = $1::uuid`, [state.restaurants.R9.id])).rows[0]
const dispute = (await stripe.disputes.list({ charge: row.charge, limit: 1 })).data[0]
log('litige Stripe (R8)', dispute ? { id: dispute.id, status: dispute.status, reason: dispute.reason, amount: dispute.amount } : null)
const counts = async () => ({
  incidents: (await pool.query('select count(*)::int n from debit_incidents')).rows[0].n,
  merchantReceivables: (await pool.query('select count(*)::int n from merchant_receivables')).rows[0].n,
  reversals: (await pool.query('select count(*)::int n from driver_transfer_reversals')).rows[0].n,
  driverReceivables: (await pool.query('select count(*)::int n from driver_receivables')).rows[0].n,
  paid: (await pool.query("select count(*)::int n from settlement_statements where status = 'paid'")).rows[0].n,
  transfers: (await pool.query("select count(*)::int n from driver_transfers where status = 'succeeded'")).rows[0].n,
})
const before = await counts()

const evt = (id: string, type: string, object: Record<string, unknown>) => ({ id, type, data: { object } })
const T = Date.now().toString(36)
const sent: Record<string, number> = {}
sent.tampered = await postSignedWebhook(evt(`evt_r90_${T}_tamper`, 'charge.dispute.created', { id: dispute.id, object: 'dispute', charge: row.charge }), { tamper: true })
sent.unknownType = await postSignedWebhook(evt(`evt_r90_${T}_unknown`, 'customer.created', { id: 'cus_r90', object: 'customer' }))
sent.dispute1 = await postSignedWebhook(evt(`evt_r90_${T}_disp`, 'charge.dispute.created', { id: dispute.id, object: 'dispute', charge: row.charge, payment_intent: row.pi }))
sent.disputeDuplicate = await postSignedWebhook(evt(`evt_r90_${T}_disp`, 'charge.dispute.created', { id: dispute.id, object: 'dispute', charge: row.charge, payment_intent: row.pi }))
// hors ordre : un « payment_intent.succeeded » ANCIEN arrive APRÈS le litige, puis un échec de R9 avant son propre débit connu
sent.staleSucceededAfterDispute = await postSignedWebhook(evt(`evt_r90_${T}_stale`, 'payment_intent.succeeded', { id: row.pi, object: 'payment_intent', latest_charge: row.charge }))
sent.r9Failed = await postSignedWebhook(evt(`evt_r90_${T}_r9`, 'payment_intent.payment_failed', { id: r9.pi, object: 'payment_intent', latest_charge: r9.charge }))
sent.unknownCharge = await postSignedWebhook(evt(`evt_r90_${T}_ghost`, 'charge.dispute.created', { id: 'dp_r90_ghost', object: 'dispute', charge: 'ch_r90_inexistant', payment_intent: 'pi_r90_inexistant' }))
log('réponses HTTP', sent)

let events: any[] = []
for (let i = 0; i < 30; i += 1) {
  await sleep(5000)
  events = (await pool.query("select event_id, event_type, status, attempt_count, last_error_class from settlement_stripe_events where event_id like $1 order by received_at", [`evt_r90_${T}%`])).rows
  if (events.filter((e) => e.status === 'processed').length >= 4) break
}
log('journal des événements', events)
const after = await counts()
const incident = (await pool.query("select kind, external_id, amount_cents::int as amount, status, reason from debit_incidents")).rows
const receivable = (await pool.query("select kind, amount_cents::int as amount, status from merchant_receivables")).rows
const d1r8 = (await pool.query(`select s.status, s.paid_cents::int as paid, s.due_cents::int as due from settlement_statements s join drivers d on d.id = s.driver_id where s.merchant_id = $1::uuid and d.name = 'Livreur R90 (test)'`, [r8.id])).rows
log('avant/après', { before, after, incident, receivable, d1r8 })
const journalIds = new Set(events.map((e) => e.event_id))
const payloadStored = (await pool.query("select column_name from information_schema.columns where table_name = 'settlement_stripe_events' and column_name ~ 'payload|body|raw'")).rows.length
const httpOk = sent.tampered >= 400 && sent.unknownType < 300 && sent.dispute1 < 300 && sent.disputeDuplicate < 300 && sent.staleSucceededAfterDispute < 300 && sent.r9Failed < 300
const domainOk = after.incidents === 1 && after.merchantReceivables === 1 && after.reversals === 0 && after.driverReceivables === 0 && after.paid === before.paid && after.transfers === before.transfers && d1r8.every((r: any) => r.paid === 0 && r.status === 'unpaid_restaurant')
evidence('C-dispute-webhooks', httpOk && domainOk && journalIds.size >= 5 && payloadStored === 0 ? 'OK' : 'KO', ['WHK-01', 'WHK-02', 'SEPA-05', 'REV-01'], { http: sent, events, before, after, incident, receivable, d1r8, payloadColumns: payloadStored })

// REC : réconciliation réelle DB ↔ Stripe
const reconcile = new S.RunSettlementReconciliationUseCase(new S.PostgresReconciliationRepository(pool), new S.StripeReconciliationReader(stripe), { debug() {}, info() {}, warn: (o: unknown, m: string) => log('WARN ' + m, o), error: (o: unknown, m: string) => log('ERROR ' + m, o) })
const summary = await reconcile.execute({ now: new Date() })
const findings = (await pool.query("select kind, scope, ref_type, count(*)::int n from settlement_reconciliation_findings where resolved_at is null group by 1,2,3 order by 2,1")).rows
log('réconciliation', { summary, findings })
const technical = findings.filter((f: any) => f.scope === 'locadely_technical')
evidence('REC-reconciliation', technical.length === 0 ? 'OK' : 'INFO', ['WHK-03', 'REC-01'], { summary, findings, note: 'les constats restaurant (débit échoué, litige) sont attendus ; aucun constat technique Locadely attendu' })
await pool.end()
