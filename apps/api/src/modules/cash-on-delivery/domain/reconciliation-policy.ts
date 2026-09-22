/**
 * Politique de réconciliation des paiements COD (T27).
 *
 * Aucune colonne de bail dédiée n'existe : `updated_at` du paiement sert de
 * bail. Un claim le remet à `now()` ; le paiement ne redevient candidat qu'une
 * fois écoulé un délai de reprise qui croît avec l'âge du paiement
 * (âge / 4, borné). Les mutations restent protégées par un compare-and-set sur
 * le statut et dérivent toujours d'une lecture Stripe faite après le claim.
 */

/** Cadence du worker. */
export const COD_RECONCILIATION_INTERVAL_MS = 60_000
/** Paiements traités par cycle. */
export const COD_RECONCILIATION_BATCH_SIZE = 10
/**
 * Délai après `expires_at` de la session avant de tenir une autorisation pour
 * abandonnée : le livreur peut reprendre une session expirée, et Stripe garde
 * l'autorisation 2 jours.
 */
export const COD_RECONCILIATION_SESSION_GRACE_SECONDS = 20 * 60
/** Délai de reprise minimal après un claim (échec Stripe transitoire compris). */
export const COD_RECONCILIATION_MIN_RETRY_SECONDS = 5 * 60
/** Délai de reprise maximal pour un paiement durablement bloqué. */
export const COD_RECONCILIATION_MAX_RETRY_SECONDS = 6 * 60 * 60
/**
 * Un paiement local `failed`/`canceled` qui porte un PaymentIntent reste
 * vérifiable pendant cette fenêtre (autorisation Stripe de 2 jours + marge) :
 * l'annulation « au mieux » de `finalize`/`retry` a pu échouer.
 */
export const COD_RECONCILIATION_TERMINAL_RECHECK_WINDOW_SECONDS = 50 * 60 * 60

export type CashOnDeliveryReconciliationPolicy = {
  sessionGraceSeconds: number
  minRetrySeconds: number
  maxRetrySeconds: number
  terminalRecheckWindowSeconds: number
}

export const defaultCashOnDeliveryReconciliationPolicy: CashOnDeliveryReconciliationPolicy = {
  sessionGraceSeconds: COD_RECONCILIATION_SESSION_GRACE_SECONDS,
  minRetrySeconds: COD_RECONCILIATION_MIN_RETRY_SECONDS,
  maxRetrySeconds: COD_RECONCILIATION_MAX_RETRY_SECONDS,
  terminalRecheckWindowSeconds: COD_RECONCILIATION_TERMINAL_RECHECK_WINDOW_SECONDS
}
