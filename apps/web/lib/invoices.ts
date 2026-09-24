import { apiFetch } from '@/lib/settlements'

// Miroir de la réponse HTTP `GET /api/v1/orders/:id/documents` — contrat :
// apps/api/src/modules/invoices/ports/invoice-repository.ts. Étape 5 Tranche 5
// (docs/work/invoicing-preparation-plan.md §15) : le statut de transmission réelle Super PDP est
// maintenant exposé (deux axes distincts, jamais fusionnés côté backend : `transmissionStatus`
// figé sur le document lui-même, `submissionStatus` = travail du worker de soumission) et le
// Factur-X est téléchargeable une fois `facturXAvailable`.
export type DocumentSubmissionStatus = 'prepared' | 'submitting' | 'submitted' | 'accepted' | 'rejected' | 'retryable' | 'failed' | 'unknown_outcome'
export type DocumentTransmissionStatus = 'not_submitted' | 'submitted' | 'confirmed' | 'rejected'

export type OrderInvoiceDocument = {
  id: string
  number: string
  issuerKind: 'driver' | 'locadely'
  invoiceTypeCode: '380' | '389'
  issuedAt: string
  totalHtCents: number
  totalVatCents: number
  totalTtcCents: number
  transmissionStatus: DocumentTransmissionStatus
  submissionStatus: DocumentSubmissionStatus
  lastError: string | null
  facturXAvailable: boolean
}

export type OrderCreditNoteDocument = {
  id: string
  number: string
  originalInvoiceNumber: string
  issuedAt: string
  totalHtCents: number
  totalVatCents: number
  totalTtcCents: number
  transmissionStatus: DocumentTransmissionStatus
  submissionStatus: DocumentSubmissionStatus
  lastError: string | null
  facturXAvailable: boolean
}

export type OrderDocuments = { invoices: OrderInvoiceDocument[]; creditNotes: OrderCreditNoteDocument[] }

export async function getOrderDocuments(orderId: string): Promise<OrderDocuments | null> {
  const result = await apiFetch<OrderDocuments>(`/api/v1/orders/${orderId}/documents`)
  return result.ok ? result.data : null
}

export function invoiceDisplayLabel(invoice: OrderInvoiceDocument): string {
  return invoice.issuerKind === 'driver' ? 'Facture livraison' : 'Facture frais de service Locadely'
}

type DocumentStatusLike = { transmissionStatus: DocumentTransmissionStatus; submissionStatus: DocumentSubmissionStatus }

// Statuts sans jargon (jamais `prepared`/`unknown_outcome`/un code fournisseur affiché tel quel) —
// même philosophie que `deriveMandateUi` (apps/mobile/lib/mandate-status.ts) : fail-closed, un
// état non explicitement reconnu retombe sur « vérification nécessaire » plutôt qu'un faux succès.
export function transmissionStatusLabel(document: DocumentStatusLike): string {
  if (document.transmissionStatus === 'confirmed' || document.submissionStatus === 'accepted') return 'Transmise'
  if (document.transmissionStatus === 'rejected') return 'Rejetée'
  if (document.submissionStatus === 'unknown_outcome') return 'Statut inconnu — vérification nécessaire'
  if (document.submissionStatus === 'failed') return 'Action requise'
  if (document.submissionStatus === 'prepared') return 'À transmettre'
  if (document.submissionStatus === 'submitting' || document.submissionStatus === 'retryable') return 'En cours d’envoi'
  if (document.submissionStatus === 'submitted') return 'Traitement en cours'
  return 'Statut inconnu — vérification nécessaire'
}

export async function getInvoiceDocumentFacturXUrl(orderId: string, documentId: string, kind: 'invoice' | 'credit_note'): Promise<string | null> {
  const result = await apiFetch<{ url: string }>(`/api/v1/orders/${orderId}/documents/${documentId}/factur-x?kind=${kind}`)
  return result.ok ? result.data.url : null
}
