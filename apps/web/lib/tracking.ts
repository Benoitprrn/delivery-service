import type { OrderStatus } from './orders'

// Miroir de PublicOrderTracking côté apps/api — voir
// apps/api/src/modules/orders/application/get-order-tracking.ts. Contrat
// volontairement minimal (page publique, sans JWT) : aucune coordonnée de
// pickup/livraison, aucune PII. driverPosition n'est jamais renseigné hors
// ASSIGNED/COLLECTED côté serveur.
export type PublicOrderTracking = {
  status: OrderStatus
  assignedAt: string | null
  collectedAt: string | null
  completedAt: string | null
  estimatedDeliveryAt: string | null
  driverPosition: { lat: number; lng: number } | null
}

// null = token inconnu (404, "lien invalide") ; une erreur réseau/serveur
// est levée séparément pour rester distinguable côté appelant.
export async function fetchOrderTracking(apiUrl: string, token: string): Promise<PublicOrderTracking | null> {
  const response = await fetch(`${apiUrl}/api/v1/orders/track/${encodeURIComponent(token)}`)
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw new Error(`Erreur serveur (${response.status})`)
  }
  return (await response.json()) as PublicOrderTracking
}

export function formatEtaTime(isoDate: string): string {
  return new Date(isoDate)
    .toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })
    .replace(':', 'h')
}

export type TrackingProgressStep = {
  key: 'pickedUp' | 'collected' | 'enRoute' | 'delivered'
  label: string
  state: 'past' | 'current' | 'future'
}

const STEP_LABELS: ReadonlyArray<[TrackingProgressStep['key'], string]> = [
  ['pickedUp', 'Pris en charge'],
  ['collected', 'Collecté'],
  ['enRoute', 'En route'],
  ['delivered', 'Livré']
]

// Le contrat public n'a que 3 timestamps (assignedAt/collectedAt/completedAt)
// pour 4 étapes visuelles : "Collecté" et "En route" partagent le même
// déclencheur (collectedAt) — il n'existe pas de distinction serveur entre
// "vient d'être collecté" et "en route vers le client". L'étape la plus
// avancée non terminale est mise en avant ("current"), les précédentes
// affichées comme acquises, aucune étape "current" une fois livré.
export function trackingProgressSteps(tracking: PublicOrderTracking): TrackingProgressStep[] {
  const done = [
    tracking.assignedAt !== null,
    tracking.collectedAt !== null,
    tracking.collectedAt !== null,
    tracking.completedAt !== null
  ]
  const lastDoneIndex = done.lastIndexOf(true)
  const isDelivered = done[3]

  return STEP_LABELS.map(([key, label], index) => ({
    key,
    label,
    state: !done[index] ? 'future' : index === lastDoneIndex && !isDelivered ? 'current' : 'past'
  }))
}

export function trackingStatusMessage(tracking: PublicOrderTracking): { icon: string; text: string } {
  if (tracking.status === 'COMPLETED') {
    return { icon: '✅', text: 'Votre commande a été livrée' }
  }
  if (tracking.driverPosition !== null) {
    return { icon: '🚴', text: 'Votre livraison est en cours' }
  }
  return { icon: '⏳', text: 'Un livreur va prendre votre commande en charge' }
}
