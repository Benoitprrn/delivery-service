'use client'

import { Camera, Clock, Euro, Link2, MapPin, Phone, Route, UserRound } from 'lucide-react'
import { useToast } from '@/components/toast-provider'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  formatDistanceKm,
  formatDurationMin,
  formatEventTime,
  formatPickupScheduledAt,
  formatPriceEuros,
  hasChargeablePrice,
  orderProgressSteps,
  STATUS_CONFIG,
  type Order,
  type ProgressStep
} from '@/lib/orders'
import { cn } from '@/lib/utils'

export type OrderModalProps = {
  order: Order | null
  onOpenChange: (open: boolean) => void
}

function progressDotClass(state: ProgressStep['state']): string {
  if (state === 'cancelled') return 'border-stone-300 bg-stone-200 text-stone-400'
  if (state === 'future') return 'border-stone-300 bg-surface text-stone-400'
  if (state === 'current') return 'border-primary-600 bg-primary-600 text-white animate-pulse'
  return 'border-primary-600 bg-primary-600 text-white'
}

function openProofInNewTab(contentType: string, contentBase64: string): void {
  const previewWindow = window.open('', '_blank')
  if (previewWindow === null) return

  const binary = window.atob(contentBase64)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: contentType }))
  previewWindow.location.href = url
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border pt-5">
      <h3 className="mb-3 text-body-sm font-semibold uppercase tracking-wide text-stone-400">{title}</h3>
      {children}
    </section>
  )
}

function ProgressBar({ order }: { order: Order }) {
  const steps = orderProgressSteps(order)

  return (
    <div className="overflow-x-auto pb-1" aria-label="Progression de la livraison">
      <div className="grid min-w-[440px] grid-cols-4">
        {steps.map((step, index) => {
          const next = steps[index + 1]
          const connectorIsComplete = next !== undefined && next.state !== 'future' && next.state !== 'cancelled'
          return (
            <div key={step.key} className="relative flex flex-col items-center text-center">
              {index < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute left-1/2 top-3 h-0.5 w-full',
                    connectorIsComplete ? 'bg-primary-600' : 'bg-stone-200'
                  )}
                />
              )}
              <span
                className={cn(
                  'relative z-10 flex h-6 w-6 items-center justify-center rounded-full border-2 text-[10px] font-bold',
                  progressDotClass(step.state)
                )}
              >
                {step.state === 'past' ? '✓' : ''}
              </span>
              <span className="mt-2 text-body-sm font-semibold text-stone-700">{step.label}</span>
              <span className="mt-0.5 text-caption text-stone-400">{step.time === null ? '--' : formatEventTime(step.time)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function OrderModal({ order, onOpenChange }: OrderModalProps) {
  const { showToast } = useToast()

  return (
    <Dialog open={order !== null} onOpenChange={onOpenChange}>
      {order !== null && (
        <DialogContent className="inset-4 z-[710] h-auto w-auto max-w-3xl overflow-hidden rounded-2xl border bg-surface p-0 shadow-2xl sm:left-1/2 sm:top-1/2 sm:right-auto sm:bottom-auto sm:max-h-[calc(100dvh-2rem)] sm:w-[min(48rem,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2">
          <DialogHeader className="shrink-0 pr-14">
            <DialogTitle>Livraison #{order.id.slice(-6)}</DialogTitle>
            <span
              className={cn(
                'mt-2 inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-body-sm font-semibold',
                STATUS_CONFIG[order.status].badgeClassName
              )}
            >
              <span aria-hidden="true">{STATUS_CONFIG[order.status].icon}</span>
              {STATUS_CONFIG[order.status].label}
            </span>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
            <div className="space-y-5">
              <ProgressBar order={order} />

              {(order.status === 'ASSIGNED' || order.status === 'COLLECTED') && (
                <a
                  href={`/track/${order.trackingToken}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-body font-semibold text-primary-700 transition-colors hover:text-primary-800 hover:underline"
                >
                  <Link2 className="h-4 w-4" />
                  Suivre la livraison en temps réel →
                </a>
              )}

              <Section title="Client">
                <div className="space-y-2 text-body text-stone-700">
                  <p className="font-medium text-stone-800">{order.customerName}</p>
                  <p className="flex items-center gap-2"><Phone className="h-4 w-4 text-stone-400" />{order.customerPhone}</p>
                  <p className="flex items-start gap-2"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-stone-400" /><span>{order.deliveryAddress}{order.deliveryAddressComplement !== null && <span className="block text-body-sm text-stone-500">{order.deliveryAddressComplement}</span>}</span></p>
                </div>
              </Section>

              <Section title="Livraison">
                <div className="space-y-2 text-body text-stone-700">
                  <p className="flex items-center gap-2"><Clock className="h-4 w-4 text-stone-400" />Collecte : {formatPickupScheduledAt(order.pickupScheduledAt)}</p>
                  <p className="flex items-center gap-2"><Route className="h-4 w-4 text-stone-400" />{formatDistanceKm(order.distanceM)} km · {formatDurationMin(order.durationS)} min · <span className="font-semibold">{hasChargeablePrice(order.status) ? `${formatPriceEuros(order.priceCents)} € HT` : '—'}</span></p>
                </div>
              </Section>

              {order.driverName !== null && (
                <Section title="Livreur">
                  <div className="space-y-2 text-body text-stone-700">
                    <p className="flex items-center gap-2 font-medium text-stone-800"><UserRound className="h-4 w-4 text-stone-400" />{order.driverName}</p>
                    {order.driverPhone !== null && <p className="flex items-center gap-2"><Phone className="h-4 w-4 text-stone-400" />{order.driverPhone}</p>}
                  </div>
                </Section>
              )}

              {(order.orderDetails !== null || order.deliveryInstructions !== null) && (
                <Section title="Commande">
                  <div className="space-y-3 text-body text-stone-700">
                    {order.orderDetails !== null && <p>{order.orderDetails}</p>}
                    {order.deliveryInstructions !== null && <p className="text-body-sm text-stone-500">{order.deliveryInstructions}</p>}
                  </div>
                </Section>
              )}

              {order.status === 'COMPLETED' && order.deliveryProofMethod !== null && (
                <Section title="Preuve">
                  {order.deliveryProofMethod === 'code' ? (
                    <p className="text-body text-stone-700">🔢 Code validé</p>
                  ) : order.proofAsset !== null ? (
                    <button
                      type="button"
                      onClick={() => {
                        const proofAsset = order.proofAsset
                        if (proofAsset === null) return
                        openProofInNewTab(proofAsset.contentType, proofAsset.contentBase64)
                      }}
                      className="inline-flex items-center gap-3 rounded-lg border border-border p-2 text-body-sm font-medium text-primary-700 hover:bg-primary-50"
                    >
                      {order.deliveryProofMethod === 'photo' ? <Camera className="h-5 w-5" /> : <span aria-hidden="true">✍️</span>}
                      <img className="h-14 w-20 rounded object-cover" alt="Preuve de livraison" src={`data:${order.proofAsset.contentType};base64,${order.proofAsset.contentBase64}`} />
                      Voir la preuve
                    </button>
                  ) : null}
                </Section>
              )}

              {(order.status === 'COMPLETED' || order.status === 'RETURNED') && (
                <button
                  type="button"
                  onClick={() => showToast({ variant: 'info', title: 'Bientôt disponible', message: 'Le signalement de litige sera disponible prochainement.' })}
                  className="text-body-sm font-semibold text-primary-700 transition-colors hover:text-primary-800 hover:underline"
                >
                  Signaler un litige
                </button>
              )}
            </div>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}
