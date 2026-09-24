import { assessChargeIncidents } from '../domain/charge-incident.js'
import { reduceStripeEvent, SETTLEMENT_WEBHOOK_EVENT_TYPES, triageSettlementEvent, type ReducedSettlementEvent } from '../domain/stripe-event-triage.js'
import type { ChargeIncidentReader, DebitOpsRepository, SettlementEventRepository } from '../ports/settlement-ops.js'
import type { SettlementLogger } from '../ports/settlement-close.js'

/** Objet Stripe pas encore (ou plus) rattachable localement : rejouable avec backoff, puis `dead_letter` visible. */
export class UnknownSettlementObjectError extends Error {}

const MAX_ATTEMPTS = 15

export type StripeEventLike = { id: string; type: string; account?: string | null; data: { object: Record<string, unknown> } }

/** Réception (signature déjà vérifiée par le module payments) : journalise seulement un type pertinent, sans payload. */
export class ReceiveSettlementWebhookUseCase {
  public constructor(private readonly repository: SettlementEventRepository, private readonly logger: SettlementLogger) {}

  public async receive(event: StripeEventLike, now: Date = new Date()): Promise<'recorded' | 'duplicate' | 'ignored'> {
    if (!SETTLEMENT_WEBHOOK_EVENT_TYPES.includes(event.type)) return 'ignored'
    const reduced = reduceStripeEvent(event)
    if (triageSettlementEvent(reduced).action === 'ignore') {
      this.logger.debug({ eventId: event.id, eventType: event.type }, 'Ignoring settlement webhook event without usable identifiers')
      return 'ignored'
    }
    return this.repository.record(reduced, now)
  }
}

/**
 * Traite le journal. L'événement n'est qu'un DÉCLENCHEUR : il n'écrit jamais un état financier depuis son contenu.
 * `refresh_debit` réveille le suivi R50 (relecture du PaymentIntent) ; `refresh_incident` relit la charge et son litige chez Stripe ;
 * `audit_transfer` relit le Transfer et le compare au ledger. Doublons et désordre sont sans effet (relecture de l'état COURANT, upserts).
 */
export class ProcessSettlementWebhooksUseCase {
  public constructor(
    private readonly events: SettlementEventRepository,
    private readonly debits: DebitOpsRepository,
    private readonly incidents: ChargeIncidentReader,
    private readonly auditTransfer: (stripeTransferId: string, now: Date) => Promise<void>,
    private readonly logger: SettlementLogger
  ) {}

  public async processBatch(input: { now: Date; limit?: number }): Promise<{ processed: number; failed: number }> {
    let processed = 0
    let failed = 0
    for (let i = 0; i < (input.limit ?? 20); i += 1) {
      const claim = await this.events.claimNext({ now: input.now, leaseSeconds: 120 })
      if (claim === null) break
      processed += 1
      try {
        await this.handle(claim.event, input.now)
        if (!(await this.events.complete(claim.event.id, claim.token, input.now))) this.logger.warn({ eventId: claim.event.id }, 'Settlement webhook claim lost before completion')
      } catch (error) {
        failed += 1
        const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError'
        const retryAfter = claim.attemptCount >= MAX_ATTEMPTS ? null : Math.min(3600, 30 * 2 ** Math.min(claim.attemptCount - 1, 7))
        await this.events.fail({ eventId: claim.event.id, token: claim.token, errorClass, retryAfterSeconds: retryAfter, now: input.now })
        this.logger.warn({ eventId: claim.event.id, eventType: claim.event.type, errorClass, deadLetter: retryAfter === null }, 'Settlement webhook processing failed')
      }
    }
    return { processed, failed }
  }

  private async handle(event: ReducedSettlementEvent, now: Date): Promise<void> {
    const action = triageSettlementEvent(event)
    if (action.action === 'ignore') return
    if (action.action === 'refresh_debit') {
      const attempt = await this.debits.findAttempt({ paymentIntentId: action.paymentIntentId, chargeId: action.chargeId })
      if (attempt === null) throw new UnknownSettlementObjectError() // l'événement peut précéder l'enregistrement local du PaymentIntent
      await this.debits.requestSync(attempt.id, now)
      return
    }
    if (action.action === 'refresh_incident') {
      const view = await this.incidents.read(action.chargeId)
      if (view === null) throw new UnknownSettlementObjectError()
      const attempt = await this.debits.findAttempt({ paymentIntentId: null, chargeId: action.chargeId })
      if (attempt === null) {
        this.logger.warn({ eventId: event.id, chargeId: action.chargeId }, 'Charge incident for a charge that is not a Locadely debit: ignored')
        return
      }
      const knownServiceRefundCents = await this.debits.knownSucceededServiceRefundCents(action.chargeId)
      const result = await this.debits.applyIncidents({ attemptId: attempt.id, chargeId: action.chargeId, assessment: assessChargeIncidents(view, knownServiceRefundCents), now })
      if (!result.applied) throw new UnknownSettlementObjectError() // débit pas encore `succeeded` localement : rejoué après le suivi R50
      return
    }
    await this.auditTransfer(action.transferId, now)
  }
}
