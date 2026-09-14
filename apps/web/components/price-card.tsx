import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export type PriceEstimate = {
  distanceM: number
  durationS: number
  priceCents: number
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
  if (status === 'error') {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 text-body-sm text-red-600">
        <span aria-hidden="true">📍</span>
        Adresse non reconnue
      </p>
    )
  }

  const label =
    status === 'success' && estimate !== undefined
      ? `${formatDistanceKm(estimate.distanceM)} km · ${formatDurationMin(estimate.durationS)} min · ${formatPriceEuros(estimate.priceCents)} €`
      : '-- km · -- min · -- €'

  return (
    <p
      className={cn(
        'mt-1.5 flex items-center gap-1.5 text-body-sm',
        status === 'success' ? 'font-semibold text-primary-700' : 'text-stone-400'
      )}
    >
      <span aria-hidden="true">📍</span>
      {label}
      {status === 'loading' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
    </p>
  )
}
