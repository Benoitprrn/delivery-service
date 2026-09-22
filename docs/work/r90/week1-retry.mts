// R90 scénario B-retry — relance MANUELLE d'un prélèvement restaurant échoué (R9 échec immédiat, R10 échec différé) via l'API admin réelle :
// refus (403 non-admin, 409 non éligible, 409 doublon), nouveau mandat, AUCUN débit sans nouvelle pré-notification, nouvelle pré-notification (tentative 2), débit réel, puis drip livreur.
import fs from 'node:fs'
import { CREDENTIALS_FILE, api, evidence, guardStripeId, log, signIn, r90Metadata } from './lib.mts'
import { S, payoutUseCase, payments, pool, preNotifier, sepaUseCase, sleep, state, stripe } from './uc.mts'

const creds = Object.fromEntries(fs.readFileSync(CREDENTIALS_FILE, 'utf8').trim().split('\n').map((l) => l.split(' ') as [string, string]))
const admin = await signIn('admin.dev@locadely.test', creds['admin.dev@locadely.test']!)
const merchantTok = await signIn('r90.merchant@locadely.test', creds['r90.merchant@locadely.test']!)
const settlementOf = async (slot: string) => (await pool.query('select id from merchant_settlements where merchant_id = $1::uuid', [state.restaurants[slot].id])).rows[0].id as string
const s9 = await settlementOf('R9'), s10 = await settlementOf('R10'), s3 = await settlementOf('R3'), s8 = await settlementOf('R8')
const attempts = async () => (await pool.query(`select m.name, a.attempt_no, a.status, a.idempotency_key, a.failure_code from debit_attempts a join merchant_settlements ms on ms.id = a.merchant_settlement_id join merchants m on m.id = ms.merchant_id where ms.id = any($1::uuid[]) order by m.name, a.attempt_no`, [[s9, s10]])).rows

// refus attendus
const r = (label: string, res: any) => ({ label, status: res.status, body: res.json?.error ?? res.json?.reason ?? null })
const refusals = [
  r('non-admin (restaurant) -> 403', await api('POST', `/api/v1/admin/settlements/${s9}/debit-retry`, merchantTok, { reason: 'test' })),
  r('règlement payé (R3) -> 409', await api('POST', `/api/v1/admin/settlements/${s3}/debit-retry`, admin, { reason: 'test non éligible' })),
  r('règlement litigieux après succès (R8) -> 409', await api('POST', `/api/v1/admin/settlements/${s8}/debit-retry`, admin, { reason: 'test litige' })),
  r('motif absent -> 400', await api('POST', `/api/v1/admin/settlements/${s9}/debit-retry`, admin, {})),
]
log('refus', refusals)

// le restaurant a remplacé son moyen de paiement (nouveau mandat SEPA valide sur le même Account)
for (const slot of ['R9', 'R10']) {
  const rest = state.restaurants[slot]
  const si = await stripe.setupIntents.create({ customer_account: rest.account, payment_method_types: ['sepa_debit'], usage: 'off_session', confirm: true,
    payment_method_data: { type: 'sepa_debit', sepa_debit: { iban: 'AT611904300234573201' }, billing_details: { name: rest.name, email: `r90-resto-${slot}@example.com` } },
    mandate_data: { customer_acceptance: { type: 'online', online: { ip_address: '127.0.0.1', user_agent: 'r90-harness' } } }, metadata: r90Metadata({ slot, purpose: 'retry-new-mandate' }) })
  const pm = await stripe.paymentMethods.retrieve(si.payment_method); const mandate = await stripe.mandates.retrieve(si.mandate)
  await pool.query("update merchant_payment_methods set status = 'detached', detached_at = now() where merchant_id = $1::uuid and status = 'active'", [rest.id])
  await pool.query(`insert into merchant_payment_methods(merchant_id, stripe_setup_intent_id, stripe_payment_method_id, stripe_mandate_id, status, last4, country, mandate_reference, activated_at) values($1::uuid,$2,$3,$4,'active',$5,'AT',$6,now())`, [rest.id, si.id, pm.id, mandate.id, pm.sepa_debit?.last4, mandate.payment_method_details?.sepa_debit?.reference])
}

const ask = async (id: string) => api('POST', `/api/v1/admin/settlements/${id}/debit-retry`, admin, { reason: 'Nouveau mandat SEPA fourni par le restaurant (test R90)' })
const req9 = await ask(s9), req10 = await ask(s10), dup9 = await ask(s9)
log('demandes de relance', { r9: req9.status, r10: req10.status, doublonR9: `${dup9.status} ${dup9.json?.reason}` })

// AUCUN débit sans pré-notification envoyée
const noNotice = await sepaUseCase().execute({ now: new Date('2026-09-16T06:00:00Z') })
const afterNoNotice = await attempts()
log('sans pré-notification : aucun débit', { summary: noNotice, attempts: afterNoNotice.length })

// nouvelle pré-notification (tentative 2) le lundi 14/09 puis débit le mercredi 16/09
const notified = await preNotifier().execute({ now: new Date('2026-09-14T09:00:00Z') })
const notices = (await pool.query("select m.name, n.attempt_no, n.status, n.debit_date::text as debit_date, n.mandate_reference is not null as has_mandate from settlement_pre_notifications n join merchant_settlements ms on ms.id = n.merchant_settlement_id join merchants m on m.id = ms.merchant_id where ms.id = any($1::uuid[]) order by m.name, n.attempt_no", [[s9, s10]])).rows
log('pré-notifications tentative 2', { notified, notices })
const t0 = Date.now(); const D = new Date('2026-09-16T06:00:00Z').getTime(); const simNow = () => new Date(D + (Date.now() - t0))
log('débit tentative 2', await sepaUseCase().execute({ now: simNow() }))
let terminal = false
for (let i = 0; i < 40 && !terminal; i += 1) {
  await sleep(10_000); await sepaUseCase().execute({ now: simNow() })
  const a = await attempts(); log('tentatives', a.map((x: any) => `${x.name.slice(-2)}#${x.attempt_no}:${x.status}`))
  terminal = a.filter((x: any) => x.attempt_no === 2).length === 2 && a.filter((x: any) => x.attempt_no === 2).every((x: any) => x.status === 'succeeded' || x.status === 'failed')
}
const finalAttempts = await attempts()
// drip livreur après régularisation
let dripped: any = null
for (let i = 0; i < 6; i += 1) { dripped = await payoutUseCase().execute({ now: new Date(`2026-09-16T${String(9 + i).padStart(2, '0')}:00:00Z`) }); if (dripped.transferred > 0) break; await sleep(5000) }
const d1 = (await pool.query(`select m.name, s.due_cents::int as due, s.paid_cents::int as paid, s.status from settlement_statements s join merchants m on m.id = s.merchant_id join drivers d on d.id = s.driver_id where d.name = 'Livreur R90 (test)' order by m.name`)).rows
const totals = (await pool.query("select (select count(*)::int from driver_transfers where status = 'succeeded') as transfers, (select count(*)::int from settlement_statements where paid_cents > due_cents) as overpaid, (select count(*)::int from driver_transfers where status='succeeded' group by statement_id having count(*)>1 limit 1) as dup")).rows[0]
log('D1 après relance', d1); log('totaux', { totals, dripped })
const refusalsOk = refusals[0].status === 403 && refusals[1].status === 409 && refusals[2].status === 409 && refusals[3].status === 400 && req9.status === 202 && req10.status === 202 && dup9.status === 409
const r9r10Paid = d1.filter((x: any) => ['R90 Resto 09', 'R90 Resto 10'].includes(x.name)).every((x: any) => x.status === 'paid' && x.paid === x.due)
const ok = refusalsOk && afterNoNotice.length === 2 && finalAttempts.filter((x: any) => x.attempt_no === 2 && x.status === 'succeeded').length === 2 && r9r10Paid && totals.overpaid === 0 && totals.dup === null && notices.every((n: any) => n.status === 'sent' && n.has_mandate)
evidence('B-retry', ok ? 'OK' : 'KO', ['SEPA-05', 'PAY-02', 'STR-01'], { refusals, requests: { r9: req9.status, r10: req10.status, dup: dup9.status }, noDebitWithoutNotification: { attemptsBefore: afterNoNotice.length, summary: noNotice }, notices, attempts: finalAttempts, d1, totals, dripped })
await pool.end()
