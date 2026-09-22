// R90 scénarios A/D/F (3/3) — pay-run R60 réel à payrun_at (11/09/2026 08:00Z, horloge simulée dans le passé réel).
// D : livreur D5 « restreint » (état posé en base comme le fait la relecture Stripe ; une restriction réelle n'est pas simulable en Sandbox) -> statements retenus, jamais bloquants pour les autres ; puis régularisation -> drip.
// F : 2 workers concurrents ; un Transfer par statement ; Σ Transfers ≤ dû ; contrôle Stripe de la charge avant CHAQUE Transfer.
import { evidence, log, RUN_ID } from './lib.mts'
import { S, debitProvider, liveReader, payoutUseCase, pool, state, stripe, transferProvider } from './uc.mts'

const PAYRUN = new Date('2026-09-11T08:00:00Z')
let rechecks = 0; const seenTransfers: any[] = []
const spyDebits = { livemode: false, retrieveDebit: async (p: string) => { rechecks += 1; return debitProvider.retrieveDebit(p) } }
const spyTransfers = { livemode: false, createTransfer: async (i: any) => { seenTransfers.push(i); return transferProvider.createTransfer(i) }, findTransfer: (i: any) => transferProvider.findTransfer(i), annotateDestinationPayment: (i: any) => transferProvider.annotateDestinationPayment(i) }
const uc = () => payoutUseCase(spyTransfers, spyDebits)

// D5 restreint (livreur de la semaine : R4, R5)
await pool.query("update driver_connect_accounts set transfers_status = 'restricted', requirements_state = 'past_due', restricted_at = now() where driver_id = $1::uuid", [state.drivers.D5.id])
log('avant payrun_at', await uc().execute({ now: new Date(PAYRUN.getTime() - 60_000) }))
const [a, b] = await Promise.all([uc().execute({ now: PAYRUN }), uc().execute({ now: PAYRUN })])
log('pay-run worker 1', a); log('pay-run worker 2', b)
const statements = async () => (await pool.query(`select d.name as driver, m.name as resto, s.due_cents::int as due, s.paid_cents::int as paid, s.status, s.payout_hold_reason as hold from settlement_statements s join drivers d on d.id = s.driver_id join merchants m on m.id = s.merchant_id order by d.name, m.name`)).rows
const st1 = await statements()
const byStatus = (rows: any[]) => rows.reduce((acc: any, r: any) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc }, {})
log('statements après pay-run', byStatus(st1))
const d5 = st1.filter((r: any) => r.driver === 'R90 Livreur 5')
const unpaid = st1.filter((r: any) => ['R90 Resto 09', 'R90 Resto 10'].includes(r.resto))
log('D5 (restreint)', d5); log('statements des restaurants impayés', unpaid)
const transfers = (await pool.query(`select t.status, t.amount_cents::int as amount, t.stripe_transfer_id, t.stripe_charge_id, t.statement_id, r.run_kind from driver_transfers t join driver_pay_runs r on r.id = t.pay_run_id`)).rows
const dupStatements = (await pool.query('select statement_id, count(*)::int n from driver_transfers where status = \'succeeded\' group by 1 having count(*) > 1')).rows
const overpaid = (await pool.query('select id from settlement_statements where paid_cents > due_cents')).rows
// Stripe : un Transfer par statement payé, destination = compte actif du livreur, source_transaction posée, run_id absent des Transferts (métadonnées applicatives) -> on relit tous les Transferts de la destination
const stripeTransfers: any[] = []
for (const [slot, d] of Object.entries<any>(state.drivers)) {
  for await (const t of stripe.transfers.list({ destination: d.account, limit: 50 })) stripeTransfers.push({ slot, id: t.id, amount: t.amount, source_transaction: t.source_transaction, destination: t.destination, reversed: t.reversed })
}
const dbIds = new Set(transfers.filter((t: any) => t.status === 'succeeded').map((t: any) => t.stripe_transfer_id))
const stripeMatchesDb = stripeTransfers.length === dbIds.size && stripeTransfers.every((t) => dbIds.has(t.id) && t.source_transaction)
const sumPaid = st1.reduce((s: number, r: any) => s + r.paid, 0); const sumTransfers = transfers.filter((t: any) => t.status === 'succeeded').reduce((s: number, t: any) => s + t.amount, 0)
log('rejeu (rien à refaire)', await uc().execute({ now: new Date(PAYRUN.getTime() + 60_000) }))
const paidCount = st1.filter((r: any) => r.status === 'paid').length
evidence('A/F-payout', dupStatements.length === 0 && overpaid.length === 0 && stripeMatchesDb && sumPaid === sumTransfers ? 'OK' : 'KO', ['PAY-01', 'PAY-02', 'STR-01', 'TST-01'],
  { statementsByStatus: byStatus(st1), paidCount, transfersInDb: transfers.length, transfersInStripe: stripeTransfers.length, stripeMatchesDb, sumPaid, sumTransfers, dupStatements, overpaid: overpaid.length, chargeRechecks: rechecks, transferCalls: seenTransfers.length, worker1: a, worker2: b, runId: RUN_ID })
evidence('D-restricted-driver', d5.length === 2 && d5.every((r: any) => r.paid === 0 && r.status !== 'paid') && paidCount > 0 ? 'OK' : 'KO', ['PAY-05', 'MOB-11', 'DRV-01'], { d5, othersPaid: paidCount, unpaidRestaurants: unpaid })

// D : régularisation du compte (état relu) -> drip au cycle suivant
await pool.query("update driver_connect_accounts set transfers_status = 'active', requirements_state = 'none', restricted_at = null where driver_id = $1::uuid", [state.drivers.D5.id])
let d5Paid = false
for (let i = 0; i < 6 && !d5Paid; i += 1) {
  await uc().execute({ now: new Date(PAYRUN.getTime() + (3 + i) * 3600_000) })
  d5Paid = (await statements()).filter((r: any) => r.driver === 'R90 Livreur 5').every((r: any) => r.status === 'paid')
  if (!d5Paid) await new Promise((r) => setTimeout(r, 3000))
}
const dripRuns = (await pool.query("select run_kind, status, statements_total, statements_paid from driver_pay_runs order by created_at")).rows
evidence('D-regularized-drip', d5Paid ? 'OK' : 'KO', ['PAY-05', 'DRV-01'], { d5Paid, payRuns: dripRuns })
await pool.end()
