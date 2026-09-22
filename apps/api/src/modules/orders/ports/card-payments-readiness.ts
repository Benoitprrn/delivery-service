/**
 * Garde de création de commande avec paiement à la livraison : le restaurant
 * doit avoir `card_payments` actif. Le module `orders` ne connaît ni Stripe ni
 * `cash-on-delivery` : `app.ts` fournit l'implémentation (qui échoue fermé).
 */
export interface CardPaymentsReadiness {
  isReady(merchantId: string): Promise<boolean>
}
