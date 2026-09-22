import { InvalidAmountError } from './errors.js'
import type { LocalDate } from './local-date.js'

/** Au-delà, un Transfer refusé n'est plus rejoué automatiquement : intervention requise (aucune perte, le dû reste au livreur). */
export const MAX_TRANSFER_TRIES = 20

/** Délai avant un nouvel essai après un refus définitif de Stripe : 15 min, 30 min, 1 h… plafonné à 6 h. */
export function transferRetryDelaySeconds(failedTries: number): number {
  if (!Number.isSafeInteger(failedTries) || failedTries < 1) throw new InvalidAmountError()
  return Math.min(6 * 3600, 900 * 2 ** Math.min(failedTries - 1, 5))
}

/** Libellé lisible dans le Dashboard Express du livreur (la `description` du Transfer ne se propage pas : annotation du paiement de destination). */
export function buildTransferDescription(input: { periodFirstDay: LocalDate; periodLastDay: LocalDate; statementId: string }): string {
  return `Locadely — livraisons du ${input.periodFirstDay} au ${input.periodLastDay} (relevé ${input.statementId.slice(0, 8)})`
}
