import type { MerchantSettlementReadiness, MerchantSettlementReadinessReader } from '../ports/merchant-settlement-readiness.js'

/**
 * Adaptateur D-D : composition de deux lectures injectées par `app.ts` (mandat SEPA actif ; informations légales
 * complètes). Fail-closed : seul `true` explicite passe ; `false`, `null` ou toute autre valeur = refus. Une erreur
 * d'infrastructure n'est jamais avalée (la commande n'est pas créée).
 */
export function createMerchantSettlementReadiness(deps: {
  hasActiveSepaMethod: (merchantId: string) => Promise<boolean>
  isLegalInformationComplete: (merchantId: string) => Promise<boolean>
}): MerchantSettlementReadinessReader {
  return {
    async check(merchantId: string): Promise<MerchantSettlementReadiness> {
      if ((await deps.hasActiveSepaMethod(merchantId)) !== true) return { ready: false, reason: 'sepa_not_configured' }
      if ((await deps.isLegalInformationComplete(merchantId)) !== true) return { ready: false, reason: 'legal_information_incomplete' }
      return { ready: true }
    }
  }
}
