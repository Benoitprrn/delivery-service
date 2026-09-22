import type { StatementStatus } from '../domain/statement-status.js'
import type { RetryAttemptSummary } from '../domain/debit-retry.js'

/**
 * R80 — port de LECTURE du règlement (SQL en PostgreSQL : `infrastructure/postgres-settlement-read-repository.ts`).
 * Lignes brutes SANS noms ni identités : l'enrichissement passe par `SettlementDirectory` (modules merchants/drivers, injecté par `app.ts`).
 */
export type DebitAttemptStatus = 'creating' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'technical_error'

export type DriverStatementRow = {
  statementId: string
  merchantId: string
  dueCents: number
  paidCents: number
  status: StatementStatus
  holdReason: string | null
  /** Statut du règlement restaurant (`merchant_settlements.status`). */
  settlementStatus: string
  /** Débit retenu : celui qui a réussi sinon le plus récent (même règle que R60). */
  debit: { attemptNo: number; status: DebitAttemptStatus } | null
  /** Incident ouvert/perdu (litige, remboursement) sur le débit retenu. */
  incidentOpen: boolean
}
export type DriverPeriodRow = { periodId: string; periodStart: Date; periodEnd: Date; closedAt: Date | null; payrunAt: Date | null; promiseDeadline: string | null; statements: DriverStatementRow[] }

export type MerchantSettlementRow = {
  merchantSettlementId: string
  periodStart: Date
  periodEnd: Date
  amountCents: number
  deliveriesCount: number
  /** `merchant_settlements.status`. */
  status: string
  /** Dernière pré-notification (plus grand `attempt_no`). */
  preNotification: { attemptNo: number; status: 'pending' | 'sending' | 'sent' | 'failed'; sentAt: Date | null; debitDate: string | null; ibanLast4: string | null; mandateReference: string | null } | null
  attempts: Array<{ attemptNo: number; status: DebitAttemptStatus; createdAt: Date; updatedAt: Date }>
  incidents: Array<{ kind: 'dispute' | 'refund'; amountCents: number; status: 'open' | 'won' | 'lost' | 'closed' }>
  openReceivablesCents: number
  /** Une pré-notification de relance existe pour une tentative pas encore créée. */
  retryRequested: boolean
}
export type MerchantSettlementLineRow = { orderId: string; finalizedAt: Date; finalStatus: 'COMPLETED' | 'RETURNED'; merchantAmountCents: number }

export type AdminSettlementRow = {
  merchantSettlementId: string
  periodStart: Date
  periodEnd: Date
  merchantId: string
  amountCents: number
  status: string
  debitBlockedReason: string | null
  attempts: Array<{ attemptNo: number; status: DebitAttemptStatus; failureCode: string | null }>
  notification: { attemptNo: number; status: string; sentAt: Date | null; debitDate: string | null; lastErrorClass: string | null } | null
  statementsCount: number
  statementsPaidCount: number
  hasOpenRetryRequest: boolean
}
export type AdminIncidentRow = { id: string; merchantId: string; kind: 'dispute' | 'refund'; amountCents: number; status: string; reason: string | null; detectedAt: Date; receivableStatus: string | null }
export type AdminReceivableRow = { scope: 'merchant' | 'driver'; id: string; ownerId: string; kind: string; amountCents: number; status: string; createdAt: Date }
export type AdminFindingRow = { id: string; kind: string; scope: 'restaurant' | 'locadely_technical'; refType: string; refId: string; expectedCents: number | null; actualCents: number | null; firstSeenAt: Date; lastSeenAt: Date }
export type AdminTransferRow = { driverTransferId: string; statementId: string; driverId: string; merchantId: string; amountCents: number; status: string; succeededAt: Date | null; reversedCents: number }
export type AdminReversalRow = { id: string; driverTransferId: string; driverId: string; status: string; category: string; reasonCode: string; reason: string; decisionReference: string; amountCents: number; requestedBy: string; approvedBy: string | null; plannedReverseCents: number | null; plannedReceivableCents: number | null; reversedCents: number | null; failureCode: string | null; createdAt: Date }
export type AdminBlockedStatementRow = { statementId: string; driverId: string; merchantId: string; dueCents: number; paidCents: number; status: string; holdReason: string | null; nextAttemptAt: Date | null }
export type AdminDeadLetterRow = { eventId: string; eventType: string; attemptCount: number; lastErrorClass: string | null; receivedAt: Date }

export type AdminOverviewRows = {
  settlements: AdminSettlementRow[]
  incidents: AdminIncidentRow[]
  receivables: AdminReceivableRow[]
  findings: AdminFindingRow[]
  transfers: AdminTransferRow[]
  reversals: AdminReversalRow[]
  blockedStatements: AdminBlockedStatementRow[]
  deadLetters: AdminDeadLetterRow[]
}

export interface SettlementReadRepository {
  /** Périodes CLÔTURÉES du livreur, les plus récentes d'abord, avec ses statements. */
  listDriverPeriods(driverId: string, limit: number): Promise<DriverPeriodRow[]>
  /** Règlements du restaurant (ne renvoie jamais un gain livreur, des frais Locadely ni l'identité d'un livreur). */
  listMerchantSettlements(merchantId: string, limit: number): Promise<MerchantSettlementRow[]>
  /** `null` si le règlement n'appartient pas à ce restaurant. */
  getMerchantSettlement(merchantId: string, merchantSettlementId: string): Promise<{ row: MerchantSettlementRow; lines: MerchantSettlementLineRow[] } | null>
  adminOverview(limit: number): Promise<AdminOverviewRows>
}

/** Noms et identité légale : fournis par les modules merchants/drivers via `app.ts` (le module settlements ne lit pas leurs tables). */
export interface SettlementDirectory {
  merchantNames(ids: readonly string[]): Promise<Map<string, string>>
  driverNames(ids: readonly string[]): Promise<Map<string, string>>
  /** `null` si l'identité légale n'est pas renseignée. */
  merchantLegalIdentity(merchantId: string): Promise<{ legalName: string; siret: string; address: string } | null>
}

export type { RetryAttemptSummary }
