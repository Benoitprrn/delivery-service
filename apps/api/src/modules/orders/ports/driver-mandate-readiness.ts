/**
 * Garde D-MD : un livreur qui n'a pas signé son mandat de facturation électronique ne se voit
 * proposer ni ne peut prendre aucune course — impossible d'émettre sa facture de livraison sans
 * mandat. Critère : mandat SIGNÉ uniquement (`driver_einvoice_mandates`, `revoked_at is null`).
 * Ne tient PAS compte de la vérification Super PDP (`provider_verification_status`) pour
 * l'instant — décision assumée, à revoir plus tard. Distincte de `DriverEInvoiceReadiness`
 * (module `invoices`), qui exige un mandat VÉRIFIÉ mais ne bloque que la transmission d'une
 * facture, jamais la course (ADR 0007 §2).
 */
export interface DriverMandateReadiness {
  isReady(driverId: string): Promise<boolean>
}
