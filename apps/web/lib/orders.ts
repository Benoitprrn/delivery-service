export type OrderStatus =
  | 'CREATED'
  | 'AVAILABLE'
  | 'ASSIGNED'
  | 'COLLECTED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'RETURNING'
  | 'RETURNED'

export type OrderEvent = {
  id: string
  fromStatus: OrderStatus | null
  toStatus: OrderStatus
  actorType: 'merchant' | 'driver' | 'system'
  actorId: string | null
  createdAt: string
}

export type DeliveryProofMethod = 'code' | 'signature' | 'photo'

export type MerchantProofAsset = {
  kind: Exclude<DeliveryProofMethod, 'code'>
  contentBase64: string
  contentType: 'image/jpeg' | 'image/png'
  createdAt: string
}

export type Order = {
  id: string
  merchantId: string
  driverId: string | null
  zoneId: string
  status: OrderStatus
  version: number
  customerName: string
  customerPhone: string
  customerEmail: string | null
  pickupScheduledAt: string | null
  orderDetails: string | null
  deliveryInstructions: string | null
  deliveryAddressComplement: string | null
  pickupAddress: string
  pickupLat: number
  pickupLng: number
  deliveryAddress: string
  deliveryLat: number
  deliveryLng: number
  distanceM: number
  durationS: number
  priceCents: number
  deliveryProofMethod: DeliveryProofMethod | null
  assignedAt: string | null
  collectedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
  events: OrderEvent[]
  driverName: string | null
  driverPhone: string | null
  proofAsset: MerchantProofAsset | null
  // TODO: TWILIO — code de livraison temporairement exposé par l'API tant
  // que l'envoi SMS n'est pas branché (Phase 2+). Présent uniquement quand
  // status === 'COLLECTED'. À retirer une fois Twilio intégré.
  deliveryCode?: string
}

export type StatusConfig = {
  label: string
  icon: string
  badgeClassName: string
}

// Palette v7 — voir le brief Phase 2 Étape 4. CANCELLED (gris) et
// RETURNING/RETURNED (rouge doux) n'ont pas d'équivalent exact dans
// tailwind.config.ts (status.cancelled y est rouge) : classes Tailwind
// directes utilisées ici plutôt qu'une extension du design system pour
// une palette encore provisoire.
export const STATUS_CONFIG: Record<OrderStatus, StatusConfig> = {
  CREATED: { label: 'Créée', icon: '⏳', badgeClassName: 'bg-status-pending-bg text-status-pending-text' },
  AVAILABLE: { label: 'En attente', icon: '⏳', badgeClassName: 'bg-status-pending-bg text-status-pending-text' },
  ASSIGNED: { label: 'Assigné', icon: '🚴', badgeClassName: 'bg-status-assigned-bg text-status-assigned-text' },
  COLLECTED: { label: 'En livraison', icon: '📍', badgeClassName: 'bg-blue-700 text-white' },
  COMPLETED: { label: 'Livré', icon: '✅', badgeClassName: 'bg-status-delivered-bg text-status-delivered-text' },
  CANCELLED: { label: 'Annulé', icon: '✕', badgeClassName: 'bg-stone-200 text-stone-700' },
  RETURNING: { label: 'Retour', icon: '↩', badgeClassName: 'bg-red-50 text-red-500' },
  RETURNED: { label: 'Retourné', icon: '↩', badgeClassName: 'bg-red-50 text-red-500' }
}

const IN_PROGRESS_STATUSES: readonly OrderStatus[] = ['AVAILABLE', 'ASSIGNED', 'COLLECTED']

export function isInProgress(status: OrderStatus): boolean {
  return IN_PROGRESS_STATUSES.includes(status)
}

// Une commande annulée/retournée n'a pas donné lieu à un paiement.
export function hasChargeablePrice(status: OrderStatus): boolean {
  return status !== 'CANCELLED' && status !== 'RETURNED'
}

export function formatPriceEuros(priceCents: number): string {
  return (priceCents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function formatDistanceKm(distanceM: number): string {
  return (distanceM / 1000).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

export function formatDurationMin(durationS: number): string {
  return Math.round(durationS / 60).toString()
}

export function formatPickupScheduledAt(pickupScheduledAt: string | null): string {
  if (pickupScheduledAt === null) {
    return 'Dès que possible'
  }

  return new Date(pickupScheduledAt)
    .toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })
    .replace(':', 'h')
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

function isSameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

// "il y a 5 min" pour le récent, "aujourd'hui"/"hier" au-delà, puis une
// date courte — couvre à la fois les commandes en cours (relatif) et
// terminées (jour) avec une seule fonction, pas deux modes séparés.
export function formatOrderTimestamp(isoDate: string, now: Date = new Date()): string {
  const date = new Date(isoDate)
  const diffMs = now.getTime() - date.getTime()

  if (diffMs < HOUR_MS) {
    const minutes = Math.max(1, Math.round(diffMs / MINUTE_MS))
    return `il y a ${minutes} min`
  }
  if (isSameCalendarDay(date, now)) {
    return "aujourd'hui"
  }
  const yesterday = new Date(now.getTime() - DAY_MS)
  if (isSameCalendarDay(date, yesterday)) {
    return 'hier'
  }
  return date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })
}

export function formatEventTime(isoDate: string): string {
  return new Date(isoDate).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })
}

export type ProgressStep = {
  key: 'created' | 'assigned' | 'collected' | 'delivered'
  label: string
  time: string | null
  state: 'past' | 'current' | 'future' | 'cancelled'
}

function transitionTime(order: Order, status: OrderStatus, fallback: string | null): string | null {
  return order.events.find((event) => event.toStatus === status)?.createdAt ?? fallback
}

export function orderProgressSteps(order: Order): ProgressStep[] {
  const times = {
    created: transitionTime(order, 'AVAILABLE', order.createdAt),
    assigned: transitionTime(order, 'ASSIGNED', order.assignedAt),
    collected: transitionTime(order, 'COLLECTED', order.collectedAt),
    delivered:
      transitionTime(order, 'COMPLETED', order.completedAt) ?? transitionTime(order, 'RETURNED', null)
  }
  const currentStep: Record<OrderStatus, ProgressStep['key'] | null> = {
    CREATED: 'created',
    AVAILABLE: 'created',
    ASSIGNED: 'assigned',
    COLLECTED: 'collected',
    COMPLETED: 'delivered',
    RETURNING: 'collected',
    RETURNED: 'delivered',
    CANCELLED: null
  }
  const current = currentStep[order.status]
  const steps: Array<Pick<ProgressStep, 'key' | 'label'> & { time: string | null }> = [
    { key: 'created', label: 'Créée', time: times.created },
    { key: 'assigned', label: 'Assignée', time: times.assigned },
    { key: 'collected', label: 'Collectée', time: times.collected },
    { key: 'delivered', label: 'Livrée', time: times.delivered }
  ]
  const currentIndex = current === null ? -1 : steps.findIndex((step) => step.key === current)
  const isDeliveryFinalized = order.status === 'COMPLETED' || order.status === 'RETURNED'

  return steps.map((step, index) => ({
    ...step,
    state:
      order.status === 'CANCELLED'
        ? 'cancelled'
        : isDeliveryFinalized && index <= currentIndex
          ? 'past'
          : index < currentIndex
            ? 'past'
            : index === currentIndex
              ? 'current'
              : 'future'
  }))
}

// Accord féminin ("la commande a été assignée…") pour la timeline de
// l'historique — distinct de STATUS_CONFIG.label qui sert le badge de
// statut et n'a pas cette contrainte grammaticale.
const EVENT_PAST_PARTICIPLE: Partial<Record<OrderStatus, string>> = {
  ASSIGNED: 'Assignée',
  COLLECTED: 'Collectée',
  COMPLETED: 'Livrée',
  CANCELLED: 'Annulée',
  RETURNING: 'Retour en cours',
  RETURNED: 'Retournée'
}

export function eventLabel(event: OrderEvent): string {
  if (event.fromStatus === null && event.toStatus === 'AVAILABLE') {
    return 'Créée'
  }
  if (event.fromStatus === 'ASSIGNED' && event.toStatus === 'AVAILABLE') {
    return 'Remise en attente (livreur)'
  }
  return EVENT_PAST_PARTICIPLE[event.toStatus] ?? STATUS_CONFIG[event.toStatus].label
}

const NEXT_STEP_LABEL: Partial<Record<OrderStatus, string>> = {
  CREATED: "En attente de publication…",
  AVAILABLE: "En attente d'un livreur…",
  ASSIGNED: 'En attente de collecte…',
  COLLECTED: 'En attente de livraison…',
  RETURNING: 'En attente de retour…'
}

// null pour un statut terminal : rien à afficher après le dernier événement.
export function nextStepLabel(status: OrderStatus): string | null {
  return NEXT_STEP_LABEL[status] ?? null
}
