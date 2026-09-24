/**
 * Garde de facturation (ADR 0006), distincte de l'éligibilité Stripe D-F.
 * Toute donnée absente rend le livreur non prêt : pas de course proposée ni acceptée.
 */
export interface DriverInvoiceReadiness {
  isReady(driverId: string): Promise<boolean>
}
