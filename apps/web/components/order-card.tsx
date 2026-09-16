import { Clock, TriangleAlert } from 'lucide-react'
import {
  formatPickupScheduledAt,
  formatPriceEuros,
  hasChargeablePrice,
  STATUS_CONFIG,
  type Order
} from '@/lib/orders'
import { cn } from '@/lib/utils'

export type OrderCardProps = {
  order: Order
  onClick: () => void
}

export function OrderCard({ order, onClick }: OrderCardProps) {
  const status = STATUS_CONFIG[order.status]

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-xl border border-border bg-surface p-4 text-left shadow-sm transition-colors duration-fast ease-default hover:bg-stone-50"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="inline-flex shrink-0 items-center gap-1 text-body-sm font-semibold text-primary-700">
              <Clock className="h-4 w-4" />
              {formatPickupScheduledAt(order.pickupScheduledAt)}
            </span>
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-body-sm font-semibold',
              status.badgeClassName
            )}
          >
            <span aria-hidden="true">{status.icon}</span>
            {status.label}
          </span>
          <span className="truncate text-body font-medium text-stone-800">{order.customerName}</span>
          </div>
          <p className="mt-1.5 truncate text-body-sm text-stone-500">{order.deliveryAddress}</p>
        </div>
        <span className="shrink-0 text-body font-semibold text-stone-800">
          {hasChargeablePrice(order.status) ? `${formatPriceEuros(order.priceCents)} €` : '—'}
        </span>
      </div>
      {order.status === 'AVAILABLE' && order.dispatchFailed && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2">
          <TriangleAlert className="h-4 w-4 shrink-0 text-red-600" />
          <span className="text-body-sm font-semibold text-red-700">Aucun livreur disponible — contactez le support</span>
        </div>
      )}
      {/* TODO: TWILIO — pont temporaire tant que le SMS n'est pas branché :
          le commerçant lit le code au client par téléphone. À retirer dès
          que Twilio est intégré (Phase 2+). */}
      {order.status === 'COLLECTED' && order.deliveryCode !== undefined && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-primary-50 px-3 py-2">
          <span className="text-body-sm font-medium text-primary-700">Code à communiquer au client :</span>
          <span className="font-mono text-body font-bold tracking-[0.2em] text-primary-800">
            {order.deliveryCode}
          </span>
        </div>
      )}
    </button>
  )
}
