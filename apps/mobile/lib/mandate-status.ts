import type { MandateBlockedReason, MandateStatus } from './mandate-types';

export type MandateTone = 'success' | 'warning' | 'danger' | 'neutral';
// `sign` : rien signé encore, l'écran de lecture/signature est accessible ; `complete-profile` : un
// prérequis manque, renvoyer vers le bon écran ; `none` : rien à faire depuis cette carte (déjà
// signé, envoyé, en attente de vérification, ou en erreur définitive nécessitant le support).
export type MandateAction = 'sign' | 'complete-profile' | 'none';

export type MandateUi = {
  tone: MandateTone;
  title: string;
  description: string;
  action: MandateAction;
  // Bandeau secondaire, jamais bloquant (ADR 0007 / plan §15.12) : les données légales du livreur
  // ont changé depuis la signature du mandat courant.
  driftNote: string | null;
};

const BLOCKED_REASON_LABEL: Record<MandateBlockedReason, string> = {
  legal_information_missing: 'Complétez vos informations professionnelles (SIRET, adresse) dans Mon compte pour pouvoir signer votre mandat de facturation.',
  driver_name_missing: 'Complétez votre prénom et nom dans Mon compte pour pouvoir signer votre mandat de facturation.',
  template_not_configured: 'Le mandat de facturation n’est pas encore disponible. Réessayez plus tard.',
  platform_identity_missing: 'Le mandat de facturation n’est pas encore disponible. Réessayez plus tard.'
};

// Libellés sans jargon Stripe/Super PDP (§9 du brief 4c) : ni `not_verified`, ni `provider_mandate_id`,
// ni un nom technique interne n'apparaît jamais à l'écran. Fail-closed comme `derivePayoutUi` : un état
// non explicitement reconnu retombe sur « Vérification en cours » plutôt que de prétendre un succès.
export function deriveMandateUi(status: MandateStatus | null): MandateUi {
  if (status === null) {
    return { tone: 'neutral', title: 'Mandat de facturation', description: 'Chargement…', action: 'none', driftNote: null };
  }

  const driftNote = status.mandateExists && status.drift?.drifted === true
    ? 'Vos informations professionnelles ont changé depuis la signature de ce mandat. Un nouveau mandat pourra vous être demandé prochainement.'
    : null;

  if (status.blockedReason !== null) {
    const actionable = status.blockedReason === 'legal_information_missing' || status.blockedReason === 'driver_name_missing';
    return {
      tone: 'warning',
      title: 'Informations à compléter',
      description: BLOCKED_REASON_LABEL[status.blockedReason],
      action: actionable ? 'complete-profile' : 'none',
      driftNote
    };
  }

  if (!status.mandateExists) {
    return {
      tone: 'neutral',
      title: 'Mandat à signer',
      description: 'Autorisez Locadely à établir vos factures en votre nom, en lisant puis en signant le mandat de facturation.',
      action: 'sign',
      driftNote
    };
  }

  if (status.submissionStatus === 'unknown_outcome' || status.submissionStatus === 'failed') {
    return {
      tone: 'danger',
      title: 'Action requise',
      description: 'L’envoi de votre mandat n’a pas pu être confirmé. Contactez l’assistance Locadely.',
      action: 'none',
      driftNote
    };
  }

  if (status.providerVerificationStatus === 'verified') {
    return { tone: 'success', title: 'Mandat vérifié', description: 'Votre mandat de facturation est actif.', action: 'none', driftNote };
  }

  if (status.providerVerificationStatus === 'rejected') {
    return {
      tone: 'danger',
      title: 'Action requise',
      description: 'Votre mandat a été refusé. Contactez l’assistance Locadely.',
      action: 'none',
      driftNote
    };
  }

  if (status.providerVerificationStatus === 'submitted' || status.providerVerificationStatus === 'not_verified') {
    return { tone: 'warning', title: 'Vérification en cours', description: 'Votre mandat a été transmis et est en cours de vérification.', action: 'none', driftNote };
  }

  // `providerVerificationStatus === 'not_submitted'` (ou une valeur non encore reconnue) : le worker
  // backend n'a pas encore soumis le mandat — envoi en cours, jamais un appel Super PDP direct depuis l'app.
  return { tone: 'warning', title: 'Envoi en cours', description: 'Votre mandat signé est en cours d’envoi.', action: 'none', driftNote };
}
