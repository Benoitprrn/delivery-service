// R90 scénario E — reversals B (faute livreur) / C (erreur Locadely) par l'API ADMIN réelle (double approbation par 2 comptes distincts), exécution réelle chez Stripe (Sandbox).
// Jamais pour un impayé/litige restaurant ; le domaine décide du recouvrable AVANT Stripe ; dépassement refusé avant Stripe ; rejeu idempotent.
import fs from 'node:fs'
import { CREDENTIALS_FILE, api, evidence, log, signIn } from './lib.mts'
import { S, pool, sleep, state, stripe } from './uc.mts'

const creds = Object.fromEntries(fs.readFileSync(CREDENTIALS_FILE, 'utf8').trim().split('\n').map((l) => l.split(' ') as [string, string]))
const a1 = await signIn('admin.dev@locadely.test', creds['admin.dev@locadely.test']!)
const a2 = await signIn('admin2.dev@locadely.test', creds['admin2.dev@locadely.test']!)
const trs = (await pool.query(`select t.id, t.stripe_transfer_id as stripe, t.amount_cents::int as amount, m.name, st.id as statement_id from driver_transfers t join settlement_statements st on st.id = t.statement_id join merchants m on m.id = st.merchant_id where t.status = 'succeeded' and st.driver_id = $1::uuid order by t.amount_cents`, [state.drivers.D1.id])).rows
const big = trs.at(-1), small = trs[0]
log('Transferts D1', trs.map((t: any) => `${t.name.slice(-2)}:${t.amount}`))
const balance = async () => { const b = await stripe.balance.retrieve({}, { stripeAccount: state.drivers.D1.account }); return { pending: b.pending.map((x: any) => x.amount), available: b.available.map((x: any) => x.amount) } }
const balBefore = await balance()
const reversalBody = (t: any, over: Record<string, unknown> = {}) => ({ driverTransferId: t.id, category: 'driver_fault', reasonCode: 'other_validated_decision', reason: 'Décision validée (test R90)', decisionReference: 'R90-B-1', amountCents: 200, ...over })
const short = (r: any) => ({ status: r.status, body: r.json?.error ?? r.json?.reason ?? r.json?.status ?? null })

// refus AVANT toute approbation / Stripe
const refusals = {
  restaurantDefault: short(await api('POST', '/api/v1/admin/reversals', a1, reversalBody(big, { reasonCode: 'restaurant_unpaid_sepa', decisionReference: 'R90-X-1' }))),
  wrongReasonForCategory: short(await api('POST', '/api/v1/admin/reversals', a1, reversalBody(big, { category: 'locadely_error', reasonCode: 'order_stolen', decisionReference: 'R90-X-2' }))),
  orderScopedWithoutOrder: short(await api('POST', '/api/v1/admin/reversals', a1, reversalBody(big, { reasonCode: 'order_stolen', decisionReference: 'R90-X-3' }))),
  overCap: short(await api('POST', '/api/v1/admin/reversals', a1, reversalBody(big, { amountCents: big.amount + 1, decisionReference: 'R90-X-4' }))),
  nonAdmin: short(await api('POST', '/api/v1/admin/reversals', undefined, reversalBody(big, { decisionReference: 'R90-X-5' }))),
}
log('refus', refusals)

// B : demande partielle (200) par admin1 ; auto-approbation refusée ; approbation par admin2
const reqB = await api('POST', '/api/v1/admin/reversals', a1, reversalBody(big))
const idB = reqB.json.reversalId as string
const dupB = await api('POST', '/api/v1/admin/reversals', a1, reversalBody(big))
const selfApprove = await api('POST', `/api/v1/admin/reversals/${idB}/approve`, a1)
const approveB = await api('POST', `/api/v1/admin/reversals/${idB}/approve`, a2)
const approveAgain = await api('POST', `/api/v1/admin/reversals/${idB}/approve`, a2)
// C : erreur Locadely, reversal TOTALE du petit Transfer, à rejeter puis redemandée avec une autre référence, approuvée
const reqC0 = await api('POST', '/api/v1/admin/reversals', a1, reversalBody(small, { category: 'locadely_error', reasonCode: 'wrong_amount', amountCents: small.amount, decisionReference: 'R90-C-0' }))
const reject = await api('POST', `/api/v1/admin/reversals/${reqC0.json.reversalId}/reject`, a2, { reason: 'Demande en double (test R90)' })
const reqC = await api('POST', '/api/v1/admin/reversals', a1, reversalBody(small, { category: 'locadely_error', reasonCode: 'wrong_amount', amountCents: small.amount, decisionReference: 'R90-C-1' }))
const approveC = await api('POST', `/api/v1/admin/reversals/${reqC.json.reversalId}/approve`, a2)
log('demandes', { reqB: short(reqB), dupB: dupB.json, selfApprove: short(selfApprove), approveB: approveB.status, approveAgain: short(approveAgain), reqC0: short(reqC0), reject: reject.status, reqC: short(reqC), approveC: approveC.status })

// exécution réelle par le worker de reversal (cas d'usage réel)
const repo = new S.PostgresDriverReversalRepository(pool)
const exec = new S.ExecuteDriverReversalsUseCase(repo, new S.StripeDriverReversalProvider(stripe, false), { debug() {}, info() {}, warn: (o: unknown, m: string) => log('WARN ' + m, o), error: (o: unknown, m: string) => log('ERROR ' + m, o) }, { retrySeconds: 5 })
const runs: any[] = []
for (let i = 0; i < 4; i += 1) { runs.push(await exec.execute({ now: new Date() })); await sleep(3000) }
const rows = (await pool.query("select decision_reference, category, reason_code, status, amount_cents::int as amount, planned_reverse_cents::int as planned, planned_receivable_cents::int as receivable, reversed_cents::int as reversed, funds_bucket, stripe_reversal_id, requested_by <> approved_by as two_people, failure_code from driver_transfer_reversals order by created_at")).rows
log('reversals (base)', rows)
const tBig = await stripe.transfers.retrieve(big.stripe), tSmall = await stripe.transfers.retrieve(small.stripe)
const balAfter = await balance()
const stmt = (await pool.query("select id, status, paid_cents::int as paid, due_cents::int as due from settlement_statements where id = any($1::uuid[])", [[big.statement_id, small.statement_id]])).rows
const receivables = (await pool.query('select count(*)::int n from driver_receivables')).rows[0].n
// rejeu de l'exécution : aucun nouvel appel Stripe (même état)
const rerun = await exec.execute({ now: new Date() })
const stripeRevs = (await stripe.transfers.listReversals(big.stripe, { limit: 10 })).data
const okDb = rows.filter((r: any) => r.status === 'executed').length === 2 && rows.every((r: any) => r.status !== 'executed' || r.two_people)
const ok = okDb && refusals.restaurantDefault.status === 400 && refusals.overCap.status === 409 && refusals.nonAdmin.status === 401 && selfApprove.status === 409 && approveB.status === 200 && approveAgain.status === 409 && reject.status === 200 && tBig.amount_reversed === 200 && tSmall.amount_reversed === small.amount && stripeRevs.length === 1 && stmt.every((s: any) => s.status === 'paid' && s.paid === s.due) && receivables === 0
log('Stripe', { big: { amount: tBig.amount, reversed: tBig.amount_reversed }, small: { amount: tSmall.amount, reversed: tSmall.amount_reversed, fully: tSmall.reversed }, balBefore, balAfter, rerun })
evidence('E-reversals', ok ? 'OK' : 'KO', ['REV-01', 'REV-02', 'REV-04', 'REV-06'], { refusals, selfApprove: short(selfApprove), approveAgain: short(approveAgain), duplicateRequestOutcome: dupB.json, rows, stripe: { bigReversed: tBig.amount_reversed, smallReversed: tSmall.amount_reversed, reversalsOnBig: stripeRevs.length }, balBefore, balAfter, statementsUnchanged: stmt, driverReceivables: receivables, rerun })
await pool.end()
