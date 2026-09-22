/**
 * Garde D-F (ADR 0004) : un livreur sans compte de paiement Stripe prêt (ou restreint plus tard) ne se voit proposer
 * ni ne peut prendre aucune course. L'implémentation lit l'état local du compte ; tout état inconnu = non éligible.
 */
export interface DriverEligibility {
  isEligible(driverId: string): Promise<boolean>
}
