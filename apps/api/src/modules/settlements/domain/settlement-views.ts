/**
 * R80 — CONTRAT des réponses HTTP de lecture du règlement (types seulement, aucune logique).
 * Dates : chaînes ISO 8601 UTC (`2026-09-14T22:00:00.000Z`) ; jours calendaires : `YYYY-MM-DD` ; argent : centimes entiers.
 * Le mobile/web n'envoient ni montant ni identifiant Stripe et ne reçoivent JAMAIS d'identifiant Stripe, de clé d'idempotence ni de code d'erreur brut.
 */

/* ---------------- Livreur : GET /api/v1/drivers/me/settlements ---------------- */
export type DriverDisplayState =
  | 'awaiting_debit' // « En attente du prélèvement du restaurant » (aucun prélèvement encore lancé, ou incident technique Locadely : jamais de faute imputée au restaurant)
  | 'debit_in_progress' // « Prélèvement du restaurant en cours »
  | 'collected_payment_scheduled' // « Encaissé — paiement prévu le … » (débit réussi, avant payrun_at)
  | 'payment_delayed' // « Paiement en cours de traitement » (encaissé, payrun_at passé, blocage côté Locadely : Transfer refusé/en attente de reprise)
  | 'sent_to_account' // « Envoyé vers votre compte de versement » (paid = due)
  | 'awaiting_restaurant_payment' // « En attente de règlement du restaurant » (débit échoué : le restaurant est débiteur)
  | 'restaurant_incident' // « Litige/remboursement du restaurant : en attente » (SEPA réussi puis contesté/remboursé avant paiement du livreur)
  | 'account_action_required' // « Votre compte de paiement doit être régularisé » (blocked_driver_account)

export type DebtorIdentity = { legalName: string; siret: string; address: string }

export type DriverStatementView = {
  statementId: string
  merchantId: string
  merchantName: string
  dueCents: number
  paidCents: number
  remainingCents: number
  displayState: DriverDisplayState
  /** `payrun_at` de la période tant que le statement n'est pas payé ; null sinon. */
  expectedPaymentAt: string | null
  /** Renseigné UNIQUEMENT si `identityVisible` (feature flag) ET état `awaiting_restaurant_payment` | `restaurant_incident`. */
  debtor: DebtorIdentity | null
}

export type DriverPeriodView = {
  periodId: string
  periodStart: string
  periodEnd: string
  closedAt: string | null
  payrunAt: string | null
  promiseDeadline: string | null
  totalCents: number
  sentCents: number
  pendingCents: number
  /** Part de `pendingCents` due par un restaurant (états `awaiting_restaurant_payment` | `restaurant_incident`). */
  unpaidByRestaurantCents: number
  statements: DriverStatementView[]
}

export type DriverSettlementsResponse = {
  generatedAt: string
  identityVisible: boolean
  /** Semaine en cours, NON clôturée : estimation des gains livreur ; null si `go_live_at` absent ou aucune course. */
  currentWeek: { periodStart: string; periodEnd: string; deliveries: number; estimatedAmountCents: number; closesAt: string } | null
  totals: { totalCents: number; sentCents: number; pendingCents: number; unpaidByRestaurantCents: number }
  periods: DriverPeriodView[]
}

/* ---------------- Restaurant : GET /api/v1/merchants/me/settlements[/:id] ---------------- */
export type MerchantDisplayState =
  | 'awaiting_notification' // règlement clôturé, pré-notification pas encore envoyée
  | 'notified' // pré-notification envoyée, prélèvement annoncé à `debit.date`
  | 'debit_in_progress'
  | 'paid'
  | 'failed' // prélèvement rejeté : le restaurant reste débiteur
  | 'incident' // SEPA réussi puis contesté/remboursé
  | 'technical_review' // incident technique Locadely (jamais présenté comme un impayé)
  | 'retry_scheduled' // relance manuelle demandée : nouvelle pré-notification en cours

export type MerchantSettlementView = {
  merchantSettlementId: string
  periodStart: string
  periodEnd: string
  amountCents: number
  /** Part due aux livreurs (ADR 0005) — `amountCents = deliveryCents + serviceFeeCents`, jamais `amountCents - serviceFeeCents` au livreur. */
  deliveryCents: number
  /** Part Locadely, additive, jamais retirée de `deliveryCents`. */
  serviceFeeCents: number
  deliveriesCount: number
  displayState: MerchantDisplayState
  debit: { date: string | null; ibanLast4: string | null; mandateReference: string | null; attemptNo: number | null; preNotifiedAt: string | null }
  retryPending: boolean
  incidentOpenCents: number
  openReceivableCents: number
}

export type MerchantSettlementsResponse = { generatedAt: string; settlements: MerchantSettlementView[] }

export type MerchantAttemptView = { attemptNo: number; outcome: 'in_progress' | 'succeeded' | 'failed' | 'technical'; at: string }
export type MerchantSettlementLineView = { orderId: string; finalizedAt: string; status: 'COMPLETED' | 'RETURNED'; amountCents: number; deliveryCents: number; serviceFeeCents: number }
export type MerchantSettlementDetailResponse = { generatedAt: string; settlement: MerchantSettlementView; attempts: MerchantAttemptView[]; lines: MerchantSettlementLineView[] }

/* ---------------- Admin : GET /api/v1/admin/settlements/overview ---------------- */
export type AdminSettlementView = {
  merchantSettlementId: string
  periodStart: string
  periodEnd: string
  merchantId: string
  merchantName: string
  amountCents: number
  status: string
  debitBlockedReason: string | null
  latestAttempt: { attemptNo: number; status: string; failureCode: string | null } | null
  notification: { attemptNo: number; status: string; sentAt: string | null; debitDate: string | null; lastErrorClass: string | null } | null
  statementsCount: number
  statementsPaidCount: number
  /** Résultat de `decideDebitRetry` : la relance manuelle est-elle permise et pourquoi pas sinon. */
  retry: { allowed: true; nextAttemptNo: number; cause: 'failed_debit' | 'technical_error' } | { allowed: false; reason: string }
}
export type AdminIncidentView = { id: string; merchantId: string; merchantName: string; kind: 'dispute' | 'refund'; amountCents: number; status: string; reason: string | null; detectedAt: string; receivableStatus: string | null }
export type AdminReceivableView = { scope: 'merchant' | 'driver'; id: string; ownerId: string; ownerName: string; kind: string; amountCents: number; status: string; createdAt: string }
export type AdminFindingView = { id: string; kind: string; scope: 'restaurant' | 'locadely_technical'; refType: string; refId: string; expectedCents: number | null; actualCents: number | null; firstSeenAt: string; lastSeenAt: string }
export type AdminTransferView = { driverTransferId: string; statementId: string; driverId: string; driverName: string; merchantId: string; merchantName: string; amountCents: number; status: string; succeededAt: string | null; reversedCents: number }
export type AdminReversalView = { id: string; driverTransferId: string; driverName: string; status: string; category: string; reasonCode: string; reason: string; decisionReference: string; amountCents: number; requestedBy: string; approvedBy: string | null; plannedReverseCents: number | null; plannedReceivableCents: number | null; reversedCents: number | null; failureCode: string | null; createdAt: string }
export type AdminBlockedStatementView = { statementId: string; driverId: string; driverName: string; merchantId: string; merchantName: string; dueCents: number; paidCents: number; status: string; holdReason: string | null; nextAttemptAt: string | null }
export type AdminDeadLetterView = { eventId: string; eventType: string; attemptCount: number; lastErrorClass: string | null; receivedAt: string }

export type AdminOverviewResponse = {
  generatedAt: string
  settlements: AdminSettlementView[]
  incidents: AdminIncidentView[]
  receivables: AdminReceivableView[]
  findings: AdminFindingView[]
  transfers: AdminTransferView[]
  reversals: AdminReversalView[]
  blockedStatements: AdminBlockedStatementView[]
  deadLetters: AdminDeadLetterView[]
}
