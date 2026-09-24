'use client'

import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import {
  apiFetch, formatCalendarDate, formatDateTime, formatEuros, formatPeriod, MERCHANT_STATE,
  type MerchantSettlementDetailResponse, type MerchantSettlementsResponse, type MerchantSettlementView
} from '@/lib/settlements'
import { cn } from '@/lib/utils'

const OUTCOME_LABEL = { in_progress: 'En cours', succeeded: 'Prélevé', failed: 'Rejeté', technical: 'Vérification Locadely' } as const

function SettlementCard({ settlement }: { settlement: MerchantSettlementView }) {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<MerchantSettlementDetailResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const state = MERCHANT_STATE[settlement.displayState]

  async function toggle(): Promise<void> {
    const next = !open
    setOpen(next)
    if (next && detail === null) {
      setLoading(true)
      const result = await apiFetch<MerchantSettlementDetailResponse>(`/api/v1/merchants/me/settlements/${settlement.merchantSettlementId}`)
      setLoading(false)
      if (result.ok) setDetail(result.data)
      else setError('Impossible de charger le détail. Réessayez.')
    }
  }

  return (
    <li className="rounded-xl border border-border bg-surface p-4 shadow-sm">
      <button type="button" onClick={() => { void toggle() }} className="flex w-full items-start gap-3 text-left" aria-expanded={open}>
        <div className="min-w-0 flex-1">
          <p className="text-body font-semibold text-stone-800">Livraisons {formatPeriod(settlement.periodStart, settlement.periodEnd)}</p>
          <p className="mt-0.5 text-body-sm text-stone-500">{settlement.deliveriesCount} course{settlement.deliveriesCount > 1 ? 's' : ''}</p>
          <span className={cn('mt-2 inline-flex rounded-full px-2.5 py-0.5 text-body-sm font-semibold', state.className)}>{state.label}</span>
        </div>
        <div className="text-right">
          <p className="text-h3 font-bold text-stone-800">{formatEuros(settlement.amountCents)} HT</p>
          {open ? <ChevronUp className="ml-auto mt-1 h-5 w-5 text-stone-400" /> : <ChevronDown className="ml-auto mt-1 h-5 w-5 text-stone-400" />}
        </div>
      </button>
      <p className="mt-2 text-body-sm text-stone-600">{state.hint}</p>
      {settlement.debit.date !== null && settlement.displayState !== 'paid' && (
        <p className="mt-1 text-body-sm text-stone-700">
          Prélèvement prévu le <strong>{formatCalendarDate(settlement.debit.date)}</strong>
          {settlement.debit.ibanLast4 !== null && <> sur le compte se terminant par <strong>{settlement.debit.ibanLast4}</strong></>}
          {settlement.debit.mandateReference !== null && <> (mandat {settlement.debit.mandateReference})</>}.
        </p>
      )}
      {(settlement.incidentOpenCents > 0 || settlement.openReceivableCents > 0) && (
        <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-body-sm font-semibold text-red-700">
          Montant resté dû : {formatEuros(Math.max(settlement.incidentOpenCents, settlement.openReceivableCents))}
        </p>
      )}
      {open && (
        <div className="mt-3 border-t border-border pt-3">
          {loading && <p className="flex items-center gap-2 text-body-sm text-stone-500"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</p>}
          {error !== null && <p className="text-body-sm text-red-600">{error}</p>}
          {detail !== null && (
            <>
              <div className="mb-3 space-y-1 rounded-lg bg-stone-50 px-3 py-2 text-body-sm text-stone-600">
                <p className="flex items-center justify-between"><span>Livraisons</span><span className="font-medium text-stone-800">{formatEuros(detail.settlement.deliveryCents)} HT</span></p>
                <p className="flex items-center justify-between"><span>Frais de service Locadely</span><span className="font-medium text-stone-800">{formatEuros(detail.settlement.serviceFeeCents)} HT</span></p>
                <p className="flex items-center justify-between border-t border-border pt-1 font-semibold text-stone-800"><span>Total</span><span>{formatEuros(detail.settlement.amountCents)} HT</span></p>
              </div>
              {detail.attempts.length > 0 && (
                <div className="mb-3">
                  <h3 className="text-body-sm font-semibold text-stone-700">Tentatives de prélèvement</h3>
                  <ul className="mt-1 space-y-1 text-body-sm text-stone-600">
                    {detail.attempts.map((attempt) => (
                      <li key={attempt.attemptNo}>Tentative {attempt.attemptNo} — {OUTCOME_LABEL[attempt.outcome]} ({formatDateTime(attempt.at)})</li>
                    ))}
                  </ul>
                </div>
              )}
              <h3 className="text-body-sm font-semibold text-stone-700">Courses de la période</h3>
              <ul className="mt-1 divide-y divide-border">
                {detail.lines.map((line) => (
                  <li key={line.orderId} className="py-1.5 text-body-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-stone-600">{formatDateTime(line.finalizedAt)}{line.status === 'RETURNED' ? ' · course retournée' : ''}</span>
                      <span className="font-semibold text-stone-800">{formatEuros(line.amountCents)}</span>
                    </div>
                    <p className="text-body-sm text-stone-400">Livraison {formatEuros(line.deliveryCents)} + service {formatEuros(line.serviceFeeCents)}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </li>
  )
}

export default function MerchantSettlementsPage() {
  const [settlements, setSettlements] = useState<MerchantSettlementView[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      const result = await apiFetch<MerchantSettlementsResponse>('/api/v1/merchants/me/settlements?limit=26')
      if (cancelled) return
      if (result.ok) setSettlements(result.data.settlements)
      else setError('Impossible de charger vos règlements. Réessayez dans un instant.')
    }
    void load()
    return () => { cancelled = true }
  }, [])

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <h1 className="text-h2 font-bold text-stone-800">Règlements</h1>
      <p className="mt-1 text-body-sm text-stone-500">Chaque lundi, Locadely clôture la semaine écoulée et vous annonce par e-mail le prélèvement SEPA du mercredi.</p>
      <div className="mt-4 min-h-0 flex-1 overflow-y-auto pb-6">
        {error !== null && <p className="rounded-lg bg-red-50 px-3 py-2 text-body-sm text-red-700">{error}</p>}
        {settlements === null && error === null && <p className="flex items-center gap-2 text-body text-stone-500"><Loader2 className="h-5 w-5 animate-spin" /> Chargement…</p>}
        {settlements !== null && settlements.length === 0 && <p className="text-body text-stone-500">Aucun règlement pour le moment. Votre première semaine clôturée apparaîtra ici.</p>}
        {settlements !== null && settlements.length > 0 && (
          <ul className="space-y-3">{settlements.map((settlement) => <SettlementCard key={settlement.merchantSettlementId} settlement={settlement} />)}</ul>
        )}
      </div>
    </div>
  )
}
