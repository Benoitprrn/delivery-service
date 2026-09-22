// R90 REC — les 38 « stripe_transfer_orphan » sont-ils des Transferts d'AUTRES environnements (bruit Sandbox) ou de R90 ?
import { evidence, log } from './lib.mts'
import { pool, state, stripe } from './uc.mts'
const cols = (await pool.query("select column_name from information_schema.columns where table_name = 'settlement_reconciliation_findings' order by ordinal_position")).rows.map((r: any) => r.column_name)
log('colonnes constats', cols)
const orphans = (await pool.query("select * from settlement_reconciliation_findings where kind = 'stripe_transfer_orphan' and resolved_at is null")).rows
const r90Destinations = new Set(Object.values<any>(state.drivers).map((d) => d.account))
const r90Transfers = new Set((await pool.query("select stripe_transfer_id from driver_transfers where stripe_transfer_id is not null")).rows.map((r: any) => r.stripe_transfer_id))
const out: any[] = []
for (const f of orphans) {
  const id = f.stripe_object_id ?? f.ref_id ?? f.external_id ?? f.object_id
  if (typeof id !== 'string' || !id.startsWith('tr_')) { out.push({ finding: f.id, id: String(id) }); continue }
  const t = await stripe.transfers.retrieve(id)
  out.push({ id, created: new Date(t.created * 1000).toISOString(), destinationIsR90: r90Destinations.has(t.destination), inR90Db: r90Transfers.has(id), amount: t.amount, metadataKeys: Object.keys(t.metadata).sort().join(',') })
}
const fromR90 = out.filter((o) => o.destinationIsR90 || o.inR90Db)
const dates = out.map((o) => o.created).filter(Boolean).sort()
log('orphelins', { total: out.length, fromR90: fromR90.length, oldest: dates[0], newest: dates.at(-1) })
evidence('REC-orphans-classification', fromR90.length === 0 ? 'OK' : 'KO', ['WHK-03', 'REC-01', 'TST-11'], { total: out.length, orphansFromR90Objects: fromR90.length, oldest: dates[0], newest: dates.at(-1), sample: out.slice(0, 3), interpretation: fromR90.length === 0 ? 'bruit historique du compte Sandbox partagé (autres bases/tests) — aucun Transfert R90 orphelin' : 'ANOMALIE' })
await pool.end()
