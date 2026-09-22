/**
 * Garde D-D (ADR 0004) : un restaurant sans mandat SEPA actif ou sans informations légales complètes ne peut pas
 * commander (aucun règlement possible). Le module `orders` ne connaît ni `payments` ni `merchants` : `app.ts` injecte
 * l'implémentation, qui échoue fermé (tout état autre que « prêt » = refus ; une erreur d'infrastructure remonte).
 */
export type MerchantSettlementReadiness =
  | { ready: true }
  | { ready: false; reason: 'sepa_not_configured' | 'legal_information_incomplete' }

export interface MerchantSettlementReadinessReader {
  check(merchantId: string): Promise<MerchantSettlementReadiness>
}
