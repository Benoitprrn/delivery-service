/**
 * Garde D-CP : un livreur dont le dossier « Mon entreprise » (identité, SIRET, adresse légale,
 * régime de TVA, pièce d'identité, Kbis) est incomplet ne se voit proposer ni ne peut prendre
 * aucune course. Distincte de D-F (compte de paiement Stripe, `DriverEligibility`) et de la garde
 * de facturation ADR 0006 (`DriverInvoiceReadiness`) — les trois causes doivent rester
 * identifiables séparément côté client.
 */
export interface DriverCompanyProfileReadiness {
  isReady(driverId: string): Promise<boolean>
}
