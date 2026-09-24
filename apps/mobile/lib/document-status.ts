// Miroir de apps/web/lib/invoices.ts → transmissionStatusLabel : mêmes deux axes de statut
// (transmission figée sur le document, soumission = travail du worker), jamais fusionnés côté
// backend, jamais un jargon technique affiché (`prepared`/`unknown_outcome`/code fournisseur).
export type DocumentSubmissionStatus = 'prepared' | 'submitting' | 'submitted' | 'accepted' | 'rejected' | 'retryable' | 'failed' | 'unknown_outcome'
export type DocumentTransmissionStatus = 'not_submitted' | 'submitted' | 'confirmed' | 'rejected'

type DocumentStatusLike = { transmissionStatus: DocumentTransmissionStatus; submissionStatus: DocumentSubmissionStatus }

export function documentStatusLabel(document: DocumentStatusLike): string {
  if (document.transmissionStatus === 'confirmed' || document.submissionStatus === 'accepted') return 'Transmise';
  if (document.transmissionStatus === 'rejected') return 'Rejetée';
  if (document.submissionStatus === 'unknown_outcome') return 'Statut inconnu — vérification nécessaire';
  if (document.submissionStatus === 'failed') return 'Action requise';
  if (document.submissionStatus === 'prepared') return 'À transmettre';
  if (document.submissionStatus === 'submitting' || document.submissionStatus === 'retryable') return 'Envoi en cours';
  if (document.submissionStatus === 'submitted') return 'Traitement en cours';
  return 'Statut inconnu — vérification nécessaire';
}
