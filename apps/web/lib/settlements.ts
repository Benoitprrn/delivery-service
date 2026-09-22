import { apiUrl } from '@/lib/config'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'

// Miroir des réponses HTTP de lecture du règlement — contrat : apps/api/src/modules/settlements/domain/settlement-views.ts.
export type MerchantDisplayState = 'awaiting_notification' | 'notified' | 'debit_in_progress' | 'paid' | 'failed' | 'incident' | 'technical_review' | 'retry_scheduled'

export type MerchantSettlementView = {
  merchantSettlementId: string
  periodStart: string
  periodEnd: string
  amountCents: number
  deliveriesCount: number
  displayState: MerchantDisplayState
  debit: { date: string | null; ibanLast4: string | null; mandateReference: string | null; attemptNo: number | null; preNotifiedAt: string | null }
  retryPending: boolean
  incidentOpenCents: number
  openReceivableCents: number
}
export type MerchantAttemptView = { attemptNo: number; outcome: 'in_progress' | 'succeeded' | 'failed' | 'technical'; at: string }
export type MerchantSettlementLineView = { orderId: string; finalizedAt: string; status: 'COMPLETED' | 'RETURNED'; amountCents: number }
export type MerchantSettlementsResponse = { generatedAt: string; settlements: MerchantSettlementView[] }
export type MerchantSettlementDetailResponse = { generatedAt: string; settlement: MerchantSettlementView; attempts: MerchantAttemptView[]; lines: MerchantSettlementLineView[] }

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

/** Appel authentifié de l'API (jeton de session Supabase) ; renvoie le corps JSON ou l'erreur normalisée. */
export async function apiFetch<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string; reason: string | null }> {
  const supabase = createSupabaseBrowserClient()
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (token === undefined) return { ok: false, status: 401, error: 'Unauthenticated', reason: null }
  try {
    const response = await fetch(`${apiUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
    })
    const json: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const record = typeof json === 'object' && json !== null ? json as Record<string, unknown> : {}
      return { ok: false, status: response.status, error: typeof record.error === 'string' ? record.error : 'RequestFailed', reason: typeof record.reason === 'string' ? record.reason : null }
    }
    return { ok: true, data: json as T }
  } catch {
    return { ok: false, status: 0, error: 'NetworkError', reason: null }
  }
}

export function formatEuros(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const euros = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${sign}${euros},${(abs % 100).toString().padStart(2, '0')} €`
}

const dayFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' })
const dateTimeFormat = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })
/** Conversion Europe/Paris côté client uniquement (règle du dépôt). */
export const formatDay = (iso: string): string => dayFormat.format(new Date(iso))
export const formatDateTime = (iso: string): string => dateTimeFormat.format(new Date(iso))
/** Période [début, fin) : le dernier jour affiché est la veille de la fin exclusive. */
export function formatPeriod(startIso: string, endIso: string): string {
  const last = new Date(new Date(endIso).getTime() - 3_600_000 * 12)
  return `du ${dayFormat.format(new Date(startIso))} au ${dayFormat.format(last)}`
}
export function formatCalendarDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return dayFormat.format(new Date(Date.UTC(year!, month! - 1, day!, 12)))
}

export const MERCHANT_STATE: Record<MerchantDisplayState, { label: string; hint: string; className: string }> = {
  awaiting_notification: { label: 'Semaine clôturée', hint: 'Le prélèvement vous sera annoncé par e-mail.', className: 'bg-stone-100 text-stone-700' },
  notified: { label: 'Prélèvement annoncé', hint: 'Le prélèvement SEPA aura lieu à la date indiquée.', className: 'bg-sky-50 text-sky-700' },
  debit_in_progress: { label: 'Prélèvement en cours', hint: 'Votre banque traite le prélèvement.', className: 'bg-amber-50 text-amber-700' },
  paid: { label: 'Prélevé', hint: 'Règlement encaissé.', className: 'bg-emerald-50 text-emerald-700' },
  failed: { label: 'Prélèvement rejeté', hint: 'Votre banque a rejeté le prélèvement : le montant reste dû. Contactez Locadely.', className: 'bg-red-50 text-red-700' },
  incident: { label: 'Contestation / remboursement', hint: 'Le prélèvement a été contesté ou remboursé : le montant concerné reste dû.', className: 'bg-red-50 text-red-700' },
  technical_review: { label: 'Vérification en cours', hint: 'Locadely vérifie le traitement de ce règlement. Aucune action de votre part.', className: 'bg-stone-100 text-stone-700' },
  retry_scheduled: { label: 'Nouveau prélèvement prévu', hint: 'Une nouvelle présentation du prélèvement vous sera annoncée par e-mail.', className: 'bg-sky-50 text-sky-700' }
}
