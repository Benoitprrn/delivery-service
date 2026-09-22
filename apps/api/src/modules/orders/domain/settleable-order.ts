/**
 * Course réglable (règlement livreurs, ADR 0004) : état FINAL `COMPLETED` ou `RETURNED`.
 * Les montants sont ceux STOCKÉS sur la commande (`driver_earning_cents`, `price_cents`) : jamais recalculés ici,
 * `pricing` reste le seul moteur de prix (ADR 0002). `finalizedAt` = `completed_at` pour `COMPLETED` ;
 * pour `RETURNED`, l'horodatage de l'événement `to_status = 'RETURNED'` du journal `order_events` (aucun
 * `returned_at` n'existe sur `orders`).
 */
export type SettleableFinalStatus = 'COMPLETED' | 'RETURNED'

export type SettleableOrder = {
  orderId: string
  merchantId: string
  driverId: string
  driverEarningCents: number
  merchantPriceCents: number
  finalStatus: SettleableFinalStatus
  createdAt: Date
  finalizedAt: Date
}

export type ListSettleableOrdersInput = {
  /** Borne basse INCLUSE de `finalizedAt`. */
  finalizedFrom: Date
  /** Borne haute EXCLUE de `finalizedAt` (intervalle demi-ouvert). */
  finalizedTo: Date
  /** Frontière de bascule (`go_live_at`) : seules les commandes créées à partir de cet instant sont réglables. */
  createdNotBefore: Date
}

export type CountExcludedOrdersInput = {
  finalizedFrom: Date
  finalizedTo: Date
  /** Frontière de bascule (`go_live_at`) : les courses finalisées dans la fenêtre mais créées AVANT sont exclues du règlement. */
  createdBefore: Date
}
