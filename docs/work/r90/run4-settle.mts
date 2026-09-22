// R90 run4 — cycle règlement ciblé (D-R) : clôture (31/08) → débit SEPA (02/09) → pay-run (11/09), même calendrier que run3
// (même go_live_at). Vérifie ensuite le Transfer Stripe réel de chaque VRAI livreur (Express v2) contre la base.
import { evidence, log, RUN_ID } from './lib.mts'
import { closeUseCase, payoutUseCase, pool, preNotifier, sentEmails, sepaUseCase, sleep, state, stripe } from './uc.mts'

const CLOSE_NOW = new Date('2026-08-30T22:05:00Z')
const DEBIT_DAY = new Date('2026-09-02T06:00:00Z')
const PAYRUN = new Date('2026-09-11T08:00:00Z')

const closed = await closeUseCase().execute({ now: CLOSE_NOW })
log('clôture', closed)
const period = (await pool.query("select id, status, closed_at, debit_date::text as debit_date, payrun_at from settlement_periods")).rows
log('période', period)

const notified = await preNotifier().execute({ now: CLOSE_NOW })
log('pré-notifications', notified)
const notifRows = (await pool.query("select status, sent_at from settlement_pre_notifications")).rows
log('pré-notif DB', notifRows)

const t0 = Date.now()
const simNow = () => new Date(DEBIT_DAY.getTime() + (Date.now() - t0))
let terminal = false
for (let i = 0; i < 40 && !terminal; i += 1) {
  const r = await sepaUseCase().execute({ now: simNow() })
  const rows = (await pool.query("select m.name, a.status from debit_attempts a join merchant_settlements ms on ms.id = a.merchant_settlement_id join merchants m on m.id = ms.merchant_id order by m.name")).rows
  log(`débit cycle ${i}`, { result: r, rows })
  terminal = rows.length === 2 && rows.every((x: any) => x.status === 'succeeded' || x.status === 'failed')
  if (!terminal) await sleep(10_000)
}
const debitRows = (await pool.query("select m.name, a.status, a.amount_cents::int as amount from debit_attempts a join merchant_settlements ms on ms.id = a.merchant_settlement_id join merchants m on m.id = ms.merchant_id order by m.name")).rows
log('débits finaux', debitRows)

const payoutResult = await payoutUseCase().execute({ now: PAYRUN })
log('pay-run', payoutResult)
const statements = (await pool.query(`select d.name as driver, m.name as resto, s.due_cents::int as due, s.paid_cents::int as paid, s.status
  from settlement_statements s join drivers d on d.id = s.driver_id join merchants m on m.id = s.merchant_id order by d.name, m.name`)).rows
log('statements', statements)

const dbTransfers = (await pool.query(`select d.name as driver, t.status, t.amount_cents::int as amount, t.stripe_transfer_id
  from driver_transfers t join settlement_statements s on s.id = t.statement_id join drivers d on d.id = s.driver_id order by d.name`)).rows

const stripeChecks: any[] = []
for (const [slot, d] of Object.entries<any>(state.drivers)) {
  const list: any[] = []
  for await (const t of stripe.transfers.list({ destination: d.account, limit: 50 })) list.push({ id: t.id, amount: t.amount, source_transaction: t.source_transaction, reversed: t.reversed })
  const dbForDriver = dbTransfers.filter((t: any) => t.driver === d.name && t.status === 'succeeded')
  const dbSum = dbForDriver.reduce((s: number, t: any) => s + t.amount, 0)
  const stripeSum = list.reduce((s: number, t: any) => s + t.amount, 0)
  stripeChecks.push({ slot, driver: d.name, account: d.account, dbTransferCount: dbForDriver.length, stripeTransferCount: list.length, dbSum, stripeSum, match: dbSum === stripeSum && dbForDriver.every((t: any) => list.some((s) => s.id === t.stripe_transfer_id)) })
}
log('vérif Stripe vs DB', stripeChecks)

const ok = debitRows.every((r: any) => r.status === 'succeeded') && statements.every((s: any) => s.status === 'paid') && stripeChecks.every((c: any) => c.match)
evidence('run4-settle', ok ? 'OK' : 'KO', ['STR-01', 'STR-13', 'PAY-01', 'PAY-02', 'TST-01'], { period, debitRows, statements, dbTransfers, stripeChecks, runId: RUN_ID })
await pool.end()
