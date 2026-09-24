import type { LocalDate } from '../domain/local-date.js'
import type { PeriodLedger, SettleableOrderInput } from '../domain/period-ledger.js'

/** Lecture des courses réglables : le module `orders` l'expose, `app.ts` l'injecte (aucun import direct de sa table). */
export interface SettleableOrdersReader {
  listSettleableOrders(input: { finalizedFrom: Date; finalizedTo: Date; createdNotBefore: Date }): Promise<SettleableOrderInput[]>
  countPreGoLiveFinalizedOrders(input: { finalizedFrom: Date; finalizedTo: Date; createdBefore: Date }): Promise<number>
}

export type SettlementSettings = {
  goLiveAt: Date | null
  payrunDelayBusinessDays: number
  promiseBusinessDays: number
}

export type ClosePeriodInput = {
  periodStart: Date
  periodEnd: Date
  debitDate: LocalDate
  payrunAtUtc: Date
  promiseDeadline: LocalDate
  excludedOrdersCount: number
  ledger: PeriodLedger
}

export interface SettlementCloseRepository {
  readSettings(): Promise<SettlementSettings>
  isPeriodClosed(periodStart: Date): Promise<boolean>
  /**
   * UNE transaction : verrou global de clôture, contrôle « déjà clôturée », période + règlements restaurant + statements + lignes
   * figées ; les totaux sont revérifiés par les contraintes différées au COMMIT. Aucun appel réseau dans la transaction.
   */
  closePeriod(input: ClosePeriodInput): Promise<'closed' | 'already_closed'>
}

export interface SettlementLogger {
  debug(object: Record<string, unknown>, message: string): void
  info(object: Record<string, unknown>, message: string): void
  warn(object: Record<string, unknown>, message: string): void
  error(object: Record<string, unknown>, message: string): void
}
