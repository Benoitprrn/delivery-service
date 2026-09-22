import { AMBER_700, EMERALD_700, RED_700, STONE_500 } from './colors';
import { formatSettlementDate } from './format';
import type { DriverDisplayState } from './settlements-types';

export type SettlementTone = 'neutre' | 'succès' | 'attente' | 'alerte';
export type SettlementLabel = { label: string; description: string; tone: SettlementTone };
type SettlementLabelDefinition = Omit<SettlementLabel, 'label'> & { label: (date: string | null) => string };

export const SETTLEMENT_TONE_COLORS: Record<SettlementTone, string> = {
  neutre: STONE_500,
  succès: EMERALD_700,
  attente: AMBER_700,
  alerte: RED_700
};

export const SETTLEMENT_LABELS: Record<DriverDisplayState, SettlementLabelDefinition> = {
  awaiting_debit: { label: () => 'En attente du prélèvement', description: 'Le règlement est en attente de traitement.', tone: 'attente' },
  debit_in_progress: { label: () => 'Prélèvement en cours', description: 'Le règlement est en cours de traitement.', tone: 'attente' },
  collected_payment_scheduled: { label: (date) => `Encaissé — paiement prévu le ${date ?? 'prochainement'}`, description: 'Le règlement a été encaissé.', tone: 'succès' },
  payment_delayed: { label: () => 'Paiement en cours de traitement', description: 'Votre paiement est en cours de traitement.', tone: 'attente' },
  sent_to_account: { label: () => 'Envoyé vers votre compte de versement', description: 'Le paiement a été envoyé.', tone: 'succès' },
  awaiting_restaurant_payment: { label: () => 'En attente du règlement du restaurant', description: 'Le règlement du restaurant est en attente.', tone: 'alerte' },
  restaurant_incident: { label: () => 'En attente : contestation du restaurant', description: 'Le règlement fait l’objet d’un suivi.', tone: 'alerte' },
  account_action_required: { label: () => 'Votre compte de paiement doit être complété', description: 'Complétez votre compte pour recevoir vos paiements.', tone: 'alerte' }
};

export function getSettlementLabel(state: DriverDisplayState, expectedPaymentAt: string | null = null): SettlementLabel {
  const definition = SETTLEMENT_LABELS[state];
  const date = expectedPaymentAt === null ? null : formatSettlementDate(expectedPaymentAt);
  return { label: definition.label(date), description: definition.description, tone: definition.tone };
}
