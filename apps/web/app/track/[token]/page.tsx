'use client'

import { use, useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { Loader2 } from 'lucide-react'
import { io, type Socket } from 'socket.io-client'
import { apiUrl } from '@/lib/config'
import {
  fetchOrderTracking,
  formatEtaTime,
  trackingProgressSteps,
  trackingStatusMessage,
  type PublicOrderTracking,
  type TrackingProgressStep
} from '@/lib/tracking'
import { cn } from '@/lib/utils'

// Leaflet touche `window` au chargement du module — doit rester hors SSR
// (même contrainte que apps/web/components/delivery-map.tsx).
const TrackingMap = dynamic(() => import('@/components/tracking-map').then((mod) => mod.TrackingMap), { ssr: false })

// Le canal Socket.io public (namespace /tracking) ne diffuse que
// driver_position_updated — aucun événement de changement de statut n'y est
// émis (règle absolue : jamais de GPS/canal technique mêlé au bus
// d'événements métier, et ce canal reste minimal). Un statut qui progresse
// (collecte, livraison) sans nouvelle position GPS ne serait donc jamais vu
// sans ce polling de secours, à bas débit et arrêté une fois livré.
const STATUS_POLL_INTERVAL_MS = 20_000

type PageState = 'loading' | 'ready' | 'invalid' | 'error'

function progressDotClass(state: TrackingProgressStep['state']): string {
  if (state === 'future') return 'border-stone-300 bg-surface text-stone-400'
  if (state === 'current') return 'border-primary-600 bg-primary-600 text-white animate-pulse'
  return 'border-primary-600 bg-primary-600 text-white'
}

// Pas de min-width/overflow-x-auto ici (contrairement à la variante utilisée
// dans la modale commerçant) : cette page est plein écran sur mobile, pas
// dans une modale au gabarit contrôlé — une largeur minimale forcée casse
// la mise en page sur un petit écran au lieu de s'adapter. grid-cols-4 se
// contente de diviser la largeur réelle disponible.
function ProgressBar({ tracking }: { tracking: PublicOrderTracking }) {
  const steps = trackingProgressSteps(tracking)

  return (
    <div className="grid grid-cols-4" aria-label="Progression de la livraison">
      {steps.map((step, index) => {
        const next = steps[index + 1]
        const connectorIsComplete = next !== undefined && next.state !== 'future'
        return (
          <div key={step.key} className="relative flex flex-col items-center text-center">
            {index < steps.length - 1 && (
              <span
                aria-hidden="true"
                className={cn(
                  'absolute left-1/2 top-2.5 h-0.5 w-full',
                  connectorIsComplete ? 'bg-primary-600' : 'bg-stone-200'
                )}
              />
            )}
            <span
              className={cn(
                'relative z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 text-[9px] font-bold',
                progressDotClass(step.state)
              )}
            >
              {step.state === 'past' ? '✓' : ''}
            </span>
            <span className="mt-2 w-full break-words px-0.5 text-caption font-semibold leading-tight text-stone-700">
              {step.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function InvalidTokenScreen() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-page-mobile text-center">
      <div className="max-w-sm space-y-2">
        <p className="text-h3 font-bold text-stone-800">Ce lien de suivi est invalide ou a expiré</p>
        <p className="text-body text-stone-500">Vérifiez le lien reçu, ou contactez le commerçant pour plus d'informations.</p>
      </div>
    </main>
  )
}

function LoadingScreen() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background">
      <Loader2 className="h-6 w-6 animate-spin text-primary-600" />
    </main>
  )
}

function ErrorScreen() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-page-mobile text-center">
      <div className="max-w-sm space-y-2">
        <p className="text-h3 font-bold text-stone-800">Suivi momentanément indisponible</p>
        <p className="text-body text-stone-500">Réessayez dans quelques instants.</p>
      </div>
    </main>
  )
}

export default function TrackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const [pageState, setPageState] = useState<PageState>('loading')
  const [tracking, setTracking] = useState<PublicOrderTracking | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const result = await fetchOrderTracking(apiUrl, token)
        if (cancelled) return
        if (result === null) {
          setPageState('invalid')
          return
        }
        setTracking(result)
        setPageState('ready')
      } catch {
        if (!cancelled) setPageState('error')
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [token])

  const status = tracking?.status
  const isDelivered = status === 'COMPLETED'

  // Polling de secours — voir le commentaire sur STATUS_POLL_INTERVAL_MS.
  useEffect(() => {
    if (pageState !== 'ready' || isDelivered) return

    const intervalId = setInterval(() => {
      void fetchOrderTracking(apiUrl, token)
        .then((result) => {
          if (result !== null) setTracking(result)
        })
        .catch(() => {
          // Échec ponctuel : sans conséquence, on retente au prochain tick.
        })
    }, STATUS_POLL_INTERVAL_MS)

    return () => clearInterval(intervalId)
  }, [pageState, isDelivered, token])

  // Position live : namespace Socket.io public dédié (/tracking), sans JWT —
  // le tracking_token opaque est la seule habilitation. Écoute active
  // uniquement tant que la livraison est en cours.
  useEffect(() => {
    if (pageState !== 'ready' || isDelivered) return

    const socket: Socket = io(`${apiUrl}/tracking`, {
      transports: ['websocket'],
      auth: { tracking_token: token }
    })

    function handlePositionUpdate(payload: unknown) {
      if (
        typeof payload === 'object' &&
        payload !== null &&
        'lat' in payload &&
        'lng' in payload &&
        typeof payload.lat === 'number' &&
        typeof payload.lng === 'number'
      ) {
        const { lat, lng } = payload
        setTracking((current) => (current === null ? current : { ...current, driverPosition: { lat, lng } }))
      }
    }

    socket.on('driver_position_updated', handlePositionUpdate)
    return () => {
      socket.off('driver_position_updated', handlePositionUpdate)
      socket.disconnect()
    }
  }, [pageState, isDelivered, token])

  if (pageState === 'loading') return <LoadingScreen />
  if (pageState === 'invalid') return <InvalidTokenScreen />
  if (pageState === 'error' || tracking === null) return <ErrorScreen />

  const message = trackingStatusMessage(tracking)

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <header className="shrink-0 border-b border-border bg-surface px-page-mobile py-3 text-center">
        <span className="text-h3 font-bold text-primary-700">Locadely</span>
      </header>

      <div className="h-[60vh] w-full shrink-0">
        <TrackingMap driverPosition={tracking.driverPosition} frozen={isDelivered} />
      </div>

      <div className="flex-1 space-y-5 px-page-mobile py-6">
        <div className="mx-auto max-w-md rounded-2xl border border-border bg-surface p-5 shadow-md">
          <ProgressBar tracking={tracking} />

          <div className="mt-5 space-y-2 border-t border-border pt-4 text-center">
            <p className="text-body-lg font-semibold text-stone-800">
              <span aria-hidden="true">{message.icon}</span> {message.text}
            </p>
            {tracking.estimatedDeliveryAt !== null && !isDelivered && (
              <p className="text-body text-stone-500">
                <span aria-hidden="true">⏱</span> Arrivée estimée : {formatEtaTime(tracking.estimatedDeliveryAt)}
              </p>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}
