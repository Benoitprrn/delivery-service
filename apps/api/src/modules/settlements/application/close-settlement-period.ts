import { buildPeriodLedger } from '../domain/period-ledger.js'
import { latestClosableMonday, previousClosingMonday } from '../domain/closing-schedule.js'
import type { LocalDate } from '../domain/local-date.js'
import { computeSettlementSchedule } from '../domain/schedule.js'
import type { SettleableOrdersReader, SettlementCloseRepository } from '../ports/settlement-close.js'

/** `go_live_at` n'est pas posé : aucune clôture n'est permise (les courses de test ne doivent jamais être réglées). */
export class GoLiveNotSetError extends Error {
  public constructor() { super('go_live_at is not set: no settlement period can be closed'); this.name = 'GoLiveNotSetError' }
}

export type ClosedPeriodSummary = {
  closingMonday: LocalDate
  periodStart: Date
  periodEnd: Date
  status: 'closed' | 'already_closed' | 'dry_run'
  debitDate: LocalDate
  payrunAtUtc: Date
  promiseDeadline: LocalDate
  merchantSettlements: number
  statements: number
  lines: number
  merchantAmountCents: number
  dueCents: number
  feeCents: number
  excludedOrdersCount: number
}

/** Au plus 12 semaines de rattrapage (arrêt serveur prolongé) : jamais de boucle sans borne. */
const MAX_CATCH_UP_WEEKS = 12

export class CloseSettlementPeriodUseCase {
  public constructor(private readonly repository: SettlementCloseRepository, private readonly orders: SettleableOrdersReader) {}

  /**
   * Clôture, de la plus ancienne à la plus récente, chaque période exigible non encore clôturée depuis `go_live_at`
   * (le lundi 00:05 Europe/Paris ; rattrapage si le worker était arrêté). Idempotente : une période déjà clôturée est
   * ignorée. `dryRun` calcule tout sans rien écrire. Refuse si `go_live_at` est absent.
   */
  public async execute(input: { now: Date; dryRun?: boolean }): Promise<ClosedPeriodSummary[]> {
    const settings = await this.repository.readSettings()
    if (settings.goLiveAt === null) throw new GoLiveNotSetError()
    const goLiveAt = settings.goLiveAt
    const schedules = []
    let monday = latestClosableMonday(input.now)
    for (let week = 0; week < MAX_CATCH_UP_WEEKS; week += 1) {
      const schedule = computeSettlementSchedule({ closingMonday: monday, payrunDelayBusinessDays: settings.payrunDelayBusinessDays, promiseBusinessDays: settings.promiseBusinessDays })
      // Une période terminée avant `go_live_at` ne peut contenir aucune course réglable.
      if (schedule.periodEnd.getTime() <= goLiveAt.getTime()) break
      // Les clôtures sont contiguës (toujours la plus ancienne d'abord) : la première période déjà close arrête la remontée.
      if (await this.repository.isPeriodClosed(schedule.periodStart)) break
      schedules.unshift({ monday, schedule })
      monday = previousClosingMonday(monday)
    }

    const summaries: ClosedPeriodSummary[] = []
    for (const { monday: closingMonday, schedule } of schedules) {
      const window = { finalizedFrom: schedule.periodStart, finalizedTo: schedule.periodEnd }
      const orders = await this.orders.listSettleableOrders({ ...window, createdNotBefore: goLiveAt })
      const excludedOrdersCount = await this.orders.countPreGoLiveFinalizedOrders({ ...window, createdBefore: goLiveAt })
      const ledger = buildPeriodLedger({ orders, feeRateBps: settings.feeRateBps, feeRuleVersion: settings.feeRuleVersion })
      const status = input.dryRun === true
        ? 'dry_run' as const
        : await this.repository.closePeriod({
          periodStart: schedule.periodStart,
          periodEnd: schedule.periodEnd,
          debitDate: schedule.debitDate,
          payrunAtUtc: schedule.payrunAtUtc,
          promiseDeadline: schedule.promiseDeadline,
          excludedOrdersCount,
          feeRateBps: settings.feeRateBps,
          feeRuleVersion: settings.feeRuleVersion,
          ledger
        })
      summaries.push({
        closingMonday,
        periodStart: schedule.periodStart,
        periodEnd: schedule.periodEnd,
        status,
        debitDate: schedule.debitDate,
        payrunAtUtc: schedule.payrunAtUtc,
        promiseDeadline: schedule.promiseDeadline,
        merchantSettlements: ledger.merchantSettlements.length,
        statements: ledger.merchantSettlements.reduce((total, settlement) => total + settlement.statements.length, 0),
        lines: ledger.linesCount,
        merchantAmountCents: ledger.merchantAmountCents,
        dueCents: ledger.dueCents,
        feeCents: ledger.feeCents,
        excludedOrdersCount
      })
    }
    return summaries
  }
}
