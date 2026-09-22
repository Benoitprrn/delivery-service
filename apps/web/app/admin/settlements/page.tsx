'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/toast-provider'
import { apiFetch, formatDateTime, formatDay, formatEuros, type AdminOverviewResponse, type AdminSettlementView, type AdminTransferView } from '@/lib/settlements'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'

const ERRORS: Record<string, string> = {
  debit_already_succeeded: 'Le prélèvement a déjà réussi.', debit_in_flight: 'Un prélèvement est en cours.', open_retry_request: 'Une relance est déjà en attente.',
  no_attempt: 'Aucun prélèvement n’a encore été tenté.', settlement_zero: 'Règlement à 0 €.', max_attempts_reached: 'Nombre maximal de tentatives atteint.'
}
const REASON_CODES: Record<'driver_fault' | 'locadely_error', Array<[string, string]>> = {
  driver_fault: [['order_stolen', 'Commande volée'], ['order_lost', 'Commande perdue'], ['order_damaged', 'Commande endommagée'], ['fraud', 'Fraude'], ['other_validated_decision', 'Autre décision validée']],
  locadely_error: [['duplicate_transfer', 'Transfer en double'], ['wrong_recipient', 'Mauvais destinataire'], ['wrong_amount', 'Mauvais montant'], ['other_locadely_error', 'Autre erreur Locadely']]
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-h3 font-bold text-stone-800">{title} <span className="text-body-sm font-normal text-stone-500">({count})</span></h2>
      <div className="mt-2 overflow-x-auto rounded-xl border border-border bg-surface">{count === 0 ? <p className="px-4 py-3 text-body-sm text-stone-500">Aucun élément.</p> : children}</div>
    </section>
  )
}
const th = 'px-3 py-2 text-left text-body-sm font-semibold text-stone-600'
const td = 'px-3 py-2 text-body-sm text-stone-800 align-top'
const Table = ({ head, children }: { head: string[]; children: ReactNode }) => (
  <table className="w-full min-w-[720px] divide-y divide-border">
    <thead className="bg-stone-50"><tr>{head.map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
    <tbody className="divide-y divide-border">{children}</tbody>
  </table>
)
const Chip = ({ children, tone }: { children: ReactNode; tone: 'ok' | 'warn' | 'bad' | 'neutral' }) => (
  <span className={cn('inline-flex rounded-full px-2 py-0.5 text-body-sm font-semibold', { ok: 'bg-emerald-50 text-emerald-700', warn: 'bg-amber-50 text-amber-700', bad: 'bg-red-50 text-red-700', neutral: 'bg-stone-100 text-stone-700' }[tone])}>{children}</span>
)
const settlementTone = (status: string): 'ok' | 'warn' | 'bad' | 'neutral' => status === 'succeeded' ? 'ok' : status === 'failed' ? 'bad' : status === 'technical_hold' ? 'warn' : 'neutral'

export default function AdminSettlementsPage() {
  const { showToast } = useToast()
  const [data, setData] = useState<AdminOverviewResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adminId, setAdminId] = useState<string | null>(null)
  const [retryTarget, setRetryTarget] = useState<AdminSettlementView | null>(null)
  const [retryReason, setRetryReason] = useState('')
  const [reversalTarget, setReversalTarget] = useState<AdminTransferView | null>(null)
  const [reversal, setReversal] = useState({ category: 'driver_fault' as 'driver_fault' | 'locadely_error', reasonCode: 'fraud', reason: '', decisionReference: '', amount: '', orderId: '' })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const result = await apiFetch<AdminOverviewResponse>('/api/v1/admin/settlements/overview?limit=100')
    if (result.ok) { setData(result.data); setError(null) } else setError(result.status === 403 ? 'Accès réservé aux administrateurs.' : 'Impossible de charger la vue d’ensemble.')
  }, [])

  useEffect(() => {
    let cancelled = false
    async function init(): Promise<void> {
      const [result, { data: { user } }] = await Promise.all([apiFetch<AdminOverviewResponse>('/api/v1/admin/settlements/overview?limit=100'), createSupabaseBrowserClient().auth.getUser()])
      if (cancelled) return
      setAdminId(user?.id ?? null)
      if (result.ok) setData(result.data)
      else setError(result.status === 403 ? 'Accès réservé aux administrateurs.' : 'Impossible de charger la vue d’ensemble.')
    }
    void init()
    return () => { cancelled = true }
  }, [])

  const technicalCount = useMemo(() => data?.findings.filter((f) => f.scope === 'locadely_technical').length ?? 0, [data])

  async function submitRetry(): Promise<void> {
    if (retryTarget === null) return
    setBusy(true)
    const result = await apiFetch(`/api/v1/admin/settlements/${retryTarget.merchantSettlementId}/debit-retry`, { method: 'POST', body: { reason: retryReason } })
    setBusy(false)
    if (result.ok) { showToast({ variant: 'success', title: 'Relance demandée', message: 'Une nouvelle pré-notification sera envoyée ; le débit ne part pas avant.' }); setRetryTarget(null); setRetryReason(''); void load() }
    else showToast({ variant: 'error', title: 'Relance refusée', message: result.reason !== null ? ERRORS[result.reason] ?? result.reason : result.error })
  }

  async function submitReversal(): Promise<void> {
    if (reversalTarget === null) return
    const amountCents = Math.round(Number(reversal.amount.replace(',', '.')) * 100)
    if (!Number.isInteger(amountCents) || amountCents <= 0) { showToast({ variant: 'error', title: 'Montant invalide' }); return }
    setBusy(true)
    const result = await apiFetch('/api/v1/admin/reversals', { method: 'POST', body: {
      driverTransferId: reversalTarget.driverTransferId, category: reversal.category, reasonCode: reversal.reasonCode, reason: reversal.reason, decisionReference: reversal.decisionReference, amountCents,
      ...(reversal.orderId.trim() === '' ? {} : { orderId: reversal.orderId.trim() })
    } })
    setBusy(false)
    if (result.ok) { showToast({ variant: 'success', title: 'Reversal demandée', message: 'Un AUTRE administrateur doit l’approuver.' }); setReversalTarget(null); void load() }
    else showToast({ variant: 'error', title: 'Reversal refusée', message: result.reason ?? result.error })
  }

  async function decide(id: string, action: 'approve' | 'reject'): Promise<void> {
    let body: unknown
    if (action === 'reject') {
      const reason = window.prompt('Motif du rejet (3 caractères minimum)')
      if (reason === null) return
      body = { reason }
    }
    setBusy(true)
    const result = await apiFetch(`/api/v1/admin/reversals/${id}/${action}`, { method: 'POST', body: body ?? {} })
    setBusy(false)
    if (result.ok) { showToast({ variant: 'success', title: action === 'approve' ? 'Reversal approuvée' : 'Reversal rejetée' }); void load() }
    else showToast({ variant: 'error', title: 'Action refusée', message: result.error === 'SameApprover' ? 'Le demandeur ne peut pas approuver sa propre reversal.' : result.error })
  }

  return (
    <div className="mx-auto max-w-[1400px]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-h2 font-bold text-stone-800">Règlements — vue d’ensemble</h1>
          <p className="text-body-sm text-stone-500">Lecture seule, sauf : relance de débit et reversals (double approbation). {data !== null && <>Mis à jour le {formatDateTime(data.generatedAt)}.</>}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => { void load() }}><RefreshCw className="h-4 w-4" /> Actualiser</Button>
      </div>
      {error !== null && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-body-sm text-red-700">{error}</p>}
      {data === null && error === null && <p className="mt-6 flex items-center gap-2 text-body text-stone-500"><Loader2 className="h-5 w-5 animate-spin" /> Chargement…</p>}
      {data !== null && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
            {[['Règlements', data.settlements.length], ['Incidents restaurant', data.incidents.length], ['Écarts techniques', technicalCount], ['Statements bloqués', data.blockedStatements.length], ['Événements en échec', data.deadLetters.length]].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl border border-border bg-surface p-3"><p className="text-body-sm text-stone-500">{label}</p><p className="text-h2 font-bold text-stone-800">{value}</p></div>
            ))}
          </div>

          <Section title="Règlements restaurants" count={data.settlements.length}>
            <Table head={['Période', 'Restaurant', 'Montant', 'État', 'Blocage', 'Dernière tentative', 'Pré-notification', 'Statements payés', 'Action']}>
              {data.settlements.map((s) => (
                <tr key={s.merchantSettlementId}>
                  <td className={td}>{formatDay(s.periodStart)}</td><td className={td}>{s.merchantName}</td><td className={td}>{formatEuros(s.amountCents)}</td>
                  <td className={td}><Chip tone={settlementTone(s.status)}>{s.status}</Chip></td>
                  <td className={td}>{s.debitBlockedReason ?? '—'}</td>
                  <td className={td}>{s.latestAttempt === null ? '—' : `#${s.latestAttempt.attemptNo} ${s.latestAttempt.status}${s.latestAttempt.failureCode !== null ? ` (${s.latestAttempt.failureCode})` : ''}`}</td>
                  <td className={td}>{s.notification === null ? '—' : `#${s.notification.attemptNo} ${s.notification.status}${s.notification.debitDate !== null ? ` · débit ${s.notification.debitDate}` : ''}${s.notification.lastErrorClass !== null ? ` · ${s.notification.lastErrorClass}` : ''}`}</td>
                  <td className={td}>{s.statementsPaidCount}/{s.statementsCount}</td>
                  <td className={td}>{s.retry.allowed ? <Button size="sm" variant="secondary" onClick={() => setRetryTarget(s)}>Relancer</Button> : <span className="text-stone-400" title={s.retry.reason}>{ERRORS[s.retry.reason] ?? s.retry.reason}</span>}</td>
                </tr>
              ))}
            </Table>
          </Section>

          <Section title="Incidents restaurant (litiges / remboursements)" count={data.incidents.length}>
            <Table head={['Détecté', 'Restaurant', 'Type', 'Montant', 'État', 'Créance', 'Motif']}>
              {data.incidents.map((i) => (
                <tr key={i.id}><td className={td}>{formatDateTime(i.detectedAt)}</td><td className={td}>{i.merchantName}</td><td className={td}>{i.kind}</td><td className={td}>{formatEuros(i.amountCents)}</td><td className={td}><Chip tone={i.status === 'won' || i.status === 'closed' ? 'ok' : 'bad'}>{i.status}</Chip></td><td className={td}>{i.receivableStatus ?? '—'}</td><td className={td}>{i.reason ?? '—'}</td></tr>
              ))}
            </Table>
          </Section>

          <Section title="Créances" count={data.receivables.length}>
            <Table head={['Créé', 'Type', 'Débiteur', 'Nature', 'Montant', 'État']}>
              {data.receivables.map((r) => (
                <tr key={`${r.scope}-${r.id}`}><td className={td}>{formatDateTime(r.createdAt)}</td><td className={td}>{r.scope === 'merchant' ? 'Restaurant' : 'Livreur'}</td><td className={td}>{r.ownerName}</td><td className={td}>{r.kind}</td><td className={td}>{formatEuros(r.amountCents)}</td><td className={td}><Chip tone={r.status === 'open' ? 'bad' : 'ok'}>{r.status}</Chip></td></tr>
              ))}
            </Table>
          </Section>

          <Section title="Constats de réconciliation ouverts" count={data.findings.length}>
            <Table head={['Vu', 'Portée', 'Constat', 'Objet', 'Attendu', 'Constaté']}>
              {data.findings.map((f) => (
                <tr key={f.id}><td className={td}>{formatDateTime(f.lastSeenAt)}</td><td className={td}><Chip tone={f.scope === 'restaurant' ? 'warn' : 'bad'}>{f.scope === 'restaurant' ? 'Restaurant' : 'Technique Locadely'}</Chip></td><td className={td}>{f.kind}</td><td className={td}>{f.refType} · {f.refId.slice(0, 12)}</td><td className={td}>{f.expectedCents === null ? '—' : formatEuros(f.expectedCents)}</td><td className={td}>{f.actualCents === null ? '—' : formatEuros(f.actualCents)}</td></tr>
              ))}
            </Table>
          </Section>

          <Section title="Statements bloqués ou en attente de reprise" count={data.blockedStatements.length}>
            <Table head={['Livreur', 'Restaurant', 'Dû', 'Payé', 'État', 'Raison', 'Prochaine tentative']}>
              {data.blockedStatements.map((b) => (
                <tr key={b.statementId}><td className={td}>{b.driverName}</td><td className={td}>{b.merchantName}</td><td className={td}>{formatEuros(b.dueCents)}</td><td className={td}>{formatEuros(b.paidCents)}</td><td className={td}>{b.status}</td><td className={td}>{b.holdReason ?? '—'}</td><td className={td}>{b.nextAttemptAt === null ? '—' : formatDateTime(b.nextAttemptAt)}</td></tr>
              ))}
            </Table>
          </Section>

          <Section title="Transferts livreurs (dernières reversals possibles)" count={data.transfers.length}>
            <Table head={['Envoyé', 'Livreur', 'Restaurant', 'Montant', 'Déjà reversé', 'Action']}>
              {data.transfers.map((t) => (
                <tr key={t.driverTransferId}><td className={td}>{t.succeededAt === null ? '—' : formatDateTime(t.succeededAt)}</td><td className={td}>{t.driverName}</td><td className={td}>{t.merchantName}</td><td className={td}>{formatEuros(t.amountCents)}</td><td className={td}>{formatEuros(t.reversedCents)}</td>
                  <td className={td}><Button size="sm" variant="secondary" onClick={() => { setReversalTarget(t); setReversal({ category: 'driver_fault', reasonCode: 'fraud', reason: '', decisionReference: '', amount: '', orderId: '' }) }}>Demander une reversal</Button></td></tr>
              ))}
            </Table>
          </Section>

          <Section title="Reversals (catégories B faute livreur / C erreur Locadely uniquement)" count={data.reversals.length}>
            <Table head={['Créée', 'Livreur', 'Catégorie · motif', 'Montant', 'État', 'Décision', 'Résultat', 'Action']}>
              {data.reversals.map((r) => (
                <tr key={r.id}><td className={td}>{formatDateTime(r.createdAt)}</td><td className={td}>{r.driverName}</td><td className={td}>{r.category} · {r.reasonCode}<br /><span className="text-stone-500">{r.reason}</span></td><td className={td}>{formatEuros(r.amountCents)}</td>
                  <td className={td}><Chip tone={r.status === 'succeeded' ? 'ok' : r.status === 'failed' || r.status === 'rejected' ? 'bad' : 'warn'}>{r.status}</Chip></td><td className={td}>{r.decisionReference}</td>
                  <td className={td}>{r.reversedCents === null ? '—' : `${formatEuros(r.reversedCents)} repris · ${formatEuros(r.plannedReceivableCents ?? 0)} créance`}{r.failureCode !== null ? ` · ${r.failureCode}` : ''}</td>
                  <td className={td}>{r.status === 'pending_approval' ? (r.requestedBy === adminId ? <span className="text-stone-400">Autre approbateur requis</span> : <span className="flex gap-2"><Button size="sm" disabled={busy} onClick={() => { void decide(r.id, 'approve') }}>Approuver</Button><Button size="sm" variant="secondary" disabled={busy} onClick={() => { void decide(r.id, 'reject') }}>Rejeter</Button></span>) : '—'}</td></tr>
              ))}
            </Table>
          </Section>

          <Section title="Événements Stripe en échec (dead letter)" count={data.deadLetters.length}>
            <Table head={['Reçu', 'Événement', 'Type', 'Tentatives', 'Dernière erreur']}>
              {data.deadLetters.map((d) => (
                <tr key={d.eventId}><td className={td}>{formatDateTime(d.receivedAt)}</td><td className={td}>{d.eventId}</td><td className={td}>{d.eventType}</td><td className={td}>{d.attemptCount}</td><td className={td}>{d.lastErrorClass ?? '—'}</td></tr>
              ))}
            </Table>
          </Section>
        </>
      )}

      <Dialog open={retryTarget !== null} onOpenChange={(open) => { if (!open) setRetryTarget(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Relancer le prélèvement</DialogTitle></DialogHeader>
          <div className="space-y-4 px-6 py-5">
            <p className="text-body-sm text-stone-600">{retryTarget?.merchantName} — {retryTarget === null ? '' : formatEuros(retryTarget.amountCents)}. La relance ouvre une NOUVELLE pré-notification ; le prélèvement ne part qu’à la date annoncée (≥ 2 jours) et avec le mandat cité.</p>
            <Textarea label="Motif (obligatoire)" value={retryReason} onChange={(e) => setRetryReason(e.target.value)} rows={3} />
            <Button disabled={busy || retryReason.trim().length < 3} onClick={() => { void submitRetry() }} fullWidth>{busy ? 'Envoi…' : 'Demander la relance'}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={reversalTarget !== null} onOpenChange={(open) => { if (!open) setReversalTarget(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Demander une reversal</DialogTitle></DialogHeader>
          <div className="space-y-4 px-6 py-5">
            <p className="text-body-sm text-stone-600">Transfert de {reversalTarget === null ? '' : formatEuros(reversalTarget.amountCents)} à {reversalTarget?.driverName}. Jamais pour un impayé ou un litige restaurant. Approbation par une autre personne requise.</p>
            <label className="flex flex-col gap-1.5 text-body-sm font-semibold text-stone-800">Catégorie
              <select className="h-12 rounded-lg border-2 border-border bg-surface px-3 text-body" value={reversal.category} onChange={(e) => { const category = e.target.value as 'driver_fault' | 'locadely_error'; setReversal({ ...reversal, category, reasonCode: REASON_CODES[category][0]![0] }) }}>
                <option value="driver_fault">B — Faute imputable au livreur</option><option value="locadely_error">C — Erreur Locadely</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-body-sm font-semibold text-stone-800">Motif
              <select className="h-12 rounded-lg border-2 border-border bg-surface px-3 text-body" value={reversal.reasonCode} onChange={(e) => setReversal({ ...reversal, reasonCode: e.target.value })}>
                {REASON_CODES[reversal.category].map(([code, label]) => <option key={code} value={code}>{label}</option>)}
              </select>
            </label>
            <Input label="Montant à reverser (€)" inputMode="decimal" value={reversal.amount} onChange={(e) => setReversal({ ...reversal, amount: e.target.value })} />
            <Input label="Référence de la décision" value={reversal.decisionReference} onChange={(e) => setReversal({ ...reversal, decisionReference: e.target.value })} />
            {['order_stolen', 'order_lost', 'order_damaged'].includes(reversal.reasonCode) && <Input label="Identifiant de la commande concernée" value={reversal.orderId} onChange={(e) => setReversal({ ...reversal, orderId: e.target.value })} />}
            <Textarea label="Explication" value={reversal.reason} onChange={(e) => setReversal({ ...reversal, reason: e.target.value })} rows={3} />
            <Button disabled={busy || reversal.reason.trim().length < 3 || reversal.decisionReference.trim() === ''} onClick={() => { void submitReversal() }} fullWidth>{busy ? 'Envoi…' : 'Demander la reversal'}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
