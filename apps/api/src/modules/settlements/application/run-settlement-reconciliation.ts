import { compareDebitAttempt, compareDriverBalance, compareStripeTransferOrphan, compareTransfer, type ReconciliationFinding } from '../domain/reconciliation.js'
import type { ExaminedRef, ReconciliationRepository, ReconciliationStripeReader } from '../ports/settlement-ops.js'
import type { SettlementLogger } from '../ports/settlement-close.js'

export type ReconciliationSummary = { runId: string; checked: number; readErrors: number; opened: number; stillOpen: number; resolved: number; restaurantFindings: number; technicalFindings: number; payoutsObserved: number }

const DAY_SECONDS = 86_400

/**
 * Réconciliation DB ↔ Stripe (quotidienne). LECTURE seule : elle ne corrige jamais rien, elle constate. Chaque constat est classé
 * `restaurant` (le prélèvement du restaurant ne se passe pas comme prévu) ou `locadely_technical` (écart d'intégrité de notre côté) —
 * jamais mélangés. Un objet qui n'a pas pu être relu n'est pas déclaré examiné (aucun constat résolu à tort).
 */
export class RunSettlementReconciliationUseCase {
  public constructor(
    private readonly repository: ReconciliationRepository,
    private readonly stripe: ReconciliationStripeReader,
    private readonly logger: SettlementLogger,
    private readonly config: { debitLookbackDays?: number; transferLookbackDays?: number; limit?: number; payoutLookbackDays?: number } = {}
  ) {}

  public async execute(input: { now: Date }): Promise<ReconciliationSummary> {
    const { now } = input
    const runId = await this.repository.startRun(now)
    const findings: ReconciliationFinding[] = []
    const examined: ExaminedRef[] = []
    let checked = 0
    let readErrors = 0
    let payoutsObserved = 0
    try {
      const limit = this.config.limit ?? 500
      for (const item of await this.repository.loadDebits({ now, sinceDays: this.config.debitLookbackDays ?? 60, limit })) {
        try {
          const stripe = item.db.paymentIntentId === null ? null : await this.stripe.readDebit(item.db.paymentIntentId)
          findings.push(...compareDebitAttempt(item.db, stripe))
          examined.push({ refType: 'debit_attempt', refId: item.db.id })
          checked += 1
        } catch (error) { readErrors += 1; this.warn('debit', error) }
      }
      const transferDays = this.config.transferLookbackDays ?? 60
      for (const item of await this.repository.loadTransfers({ now, sinceDays: transferDays, limit })) {
        try {
          const stripe = item.db.stripeTransferId === null ? null : await this.stripe.readTransfer(item.db.stripeTransferId)
          findings.push(...compareTransfer(item.db, stripe, item.ledgerReversedCents))
          examined.push({ refType: 'driver_transfer', refId: item.db.id })
          checked += 1
        } catch (error) { readErrors += 1; this.warn('transfer', error) }
      }
      // Sens inverse : ce que Stripe a créé récemment et que la base ne connaît pas.
      try {
        const recent = await this.stripe.listRecentTransfers(Math.floor(now.getTime() / 1000) - 7 * DAY_SECONDS)
        const known = await this.repository.knownDriverTransferIds(recent.flatMap((t) => t.driverTransferIdMetadata === null ? [] : [t.driverTransferIdMetadata]))
        for (const transfer of recent) {
          findings.push(...compareStripeTransferOrphan({ transferId: transfer.transferId, amountCents: transfer.amountCents, driverTransferIdMetadata: transfer.driverTransferIdMetadata }, transfer.driverTransferIdMetadata !== null && known.has(transfer.driverTransferIdMetadata)))
          examined.push({ refType: 'stripe_orphan', refId: transfer.transferId })
        }
        checked += recent.length
      } catch (error) { readErrors += 1; this.warn('recent_transfers', error) }
      for (const account of await this.repository.loadDriverAccounts()) {
        try {
          const balance = await this.stripe.readDriverBalance(account.stripeAccountId)
          if (balance !== null) {
            findings.push(...compareDriverBalance({ driverId: account.driverId, availableCents: balance.availableCents, pendingCents: balance.pendingCents, openReceivablesCents: account.openReceivablesCents }))
            examined.push({ refType: 'driver_balance', refId: account.driverId })
            checked += 1
          }
          const payouts = await this.stripe.listPayouts(account.stripeAccountId, Math.floor(now.getTime() / 1000) - (this.config.payoutLookbackDays ?? 30) * DAY_SECONDS)
          payoutsObserved += await this.repository.upsertPayouts(payouts.map((p) => ({ driverId: account.driverId, stripeAccountId: account.stripeAccountId, payoutId: p.payoutId, amountCents: p.amountCents, status: p.status, automatic: p.automatic, arrivalDate: p.arrivalDate, livemode: account.livemode })), now)
        } catch (error) { readErrors += 1; this.warn('driver_account', error) }
      }
      const recorded = await this.repository.recordFindings({ runId, findings, examined, now })
      const restaurantFindings = findings.filter((f) => f.scope === 'restaurant').length
      const technicalFindings = findings.length - restaurantFindings
      await this.repository.finishRun({ runId, status: 'completed', checked, discrepancies: findings.length, summary: { readErrors, restaurantFindings, technicalFindings, opened: recorded.opened, resolved: recorded.resolved, payoutsObserved }, now })
      if (technicalFindings > 0) this.logger.error({ runId, technicalFindings }, 'Settlement reconciliation found technical discrepancies (Locadely side): intervention required')
      if (restaurantFindings > 0) this.logger.warn({ runId, restaurantFindings }, 'Settlement reconciliation found restaurant debit incidents')
      return { runId, checked, readErrors, opened: recorded.opened, stillOpen: recorded.stillOpen, resolved: recorded.resolved, restaurantFindings, technicalFindings, payoutsObserved }
    } catch (error) {
      await this.repository.finishRun({ runId, status: 'failed', checked, discrepancies: findings.length, summary: { readErrors }, now })
      throw error
    }
  }

  /** Audit ciblé d'un Transfer (déclenché par un webhook) : relit Stripe, compare au ledger, enregistre les constats ; ne crée aucun passage quotidien. */
  public async auditTransfer(stripeTransferId: string, now: Date): Promise<void> {
    const item = await this.repository.loadTransferByStripeId(stripeTransferId, now)
    if (item === null) {
      // Transfer Stripe sans ligne locale portant son id : légitime seulement si sa métadonnée désigne une ligne locale encore « creating ».
      const origin = await this.stripe.readTransferOrigin(stripeTransferId)
      if (origin === null) return
      const known = origin.driverTransferIdMetadata !== null && (await this.repository.knownDriverTransferIds([origin.driverTransferIdMetadata])).has(origin.driverTransferIdMetadata)
      await this.repository.recordFindings({ runId: null, findings: compareStripeTransferOrphan(origin, known), examined: [{ refType: 'stripe_orphan', refId: origin.transferId }], now })
      return
    }
    const stripe = await this.stripe.readTransfer(stripeTransferId)
    await this.repository.recordFindings({ runId: null, findings: compareTransfer(item.db, stripe, item.ledgerReversedCents), examined: [{ refType: 'driver_transfer', refId: item.db.id }], now })
  }

  private warn(what: string, error: unknown): void {
    this.logger.warn({ what, errorClass: error instanceof Error ? error.constructor.name : 'UnknownError' }, 'Reconciliation could not read a Stripe object; it is skipped this run')
  }
}
