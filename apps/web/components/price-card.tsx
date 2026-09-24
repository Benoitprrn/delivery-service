import { useState } from 'react'
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export type PriceEstimate = {
  distanceM: number
  durationS: number
  // Montant dû au livreur (ex-`priceCents`) et frais de service Locadely, additif (ADR 0005) —
  // le total affiché au restaurant est toujours deliveryCents + serviceFeeCents, jamais l'un
  // sans l'autre ni une soustraction.
  deliveryCents: number
  serviceFeeCents: number
}

export type PriceCardStatus = 'idle' | 'loading' | 'success' | 'error'

export type PriceCardProps = {
  status: PriceCardStatus
  estimate?: PriceEstimate | undefined
}

function formatDistanceKm(distanceM: number): string {
  return (distanceM / 1000).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

function formatDurationMin(durationS: number): string {
  return Math.round(durationS / 60).toString()
}

function formatPriceEuros(priceCents: number): string {
  return (priceCents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Ligne discrète sous le champ adresse — jamais de carte ni de bloc d'erreur
// visible, juste un texte qui change de couleur/contenu selon l'état.
export function PriceCard({ status, estimate }: PriceCardProps) {
  const [showDetail, setShowDetail] = useState(false)

  if (status === 'error') {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 text-body-sm text-red-600">
        <span aria-hidden="true">📍</span>
        Adresse non reconnue
      </p>
    )
  }

  const totalCents = estimate !== undefined ? estimate.deliveryCents + estimate.serviceFeeCents : undefined
  const label =
    status === 'success' && estimate !== undefined && totalCents !== undefined
      ? `${formatDistanceKm(estimate.distanceM)} km · ${formatDurationMin(estimate.durationS)} min · ${formatPriceEuros(totalCents)} € HT`
      : '-- km · -- min · -- €'

  return (
    <div className="mt-1.5">
      <p
        className={cn(
          'flex flex-wrap items-center gap-1.5 text-body-sm',
          status === 'success' ? 'font-semibold text-primary-700' : 'text-stone-400'
        )}
      >
        <span aria-hidden="true">📍</span>
        {label}
        {status === 'loading' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {status === 'success' && estimate !== undefined && (
          <button
            type="button"
            onClick={() => setShowDetail((value) => !value)}
            className="inline-flex items-center gap-0.5 font-normal text-stone-400 transition-colors hover:text-primary-700"
            aria-expanded={showDetail}
          >
            Détail
            {showDetail ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        )}
      </p>
      {showDetail && status === 'success' && estimate !== undefined && (
        <div className="mt-1 space-y-1 rounded-lg bg-stone-50 px-3 py-2 text-body-sm text-stone-600">
          <p className="flex items-center justify-between"><span>Livraison</span><span className="font-medium text-stone-800">{formatPriceEuros(estimate.deliveryCents)} € HT</span></p>
          <p className="flex items-center justify-between"><span>Frais de service Locadely</span><span className="font-medium text-stone-800">{formatPriceEuros(estimate.serviceFeeCents)} € HT</span></p>
        </div>
      )}
    </div>
  )
}
