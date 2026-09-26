import type { PayoutAccountState } from './payout-types';

export type PayoutTone = 'success' | 'warning' | 'danger' | 'neutral';
// `create` : aucun compte (choix du type d'entité) ; `onboard` : terminer/reprendre la configuration ; `none` : rien à faire.
export type PayoutAction = 'create' | 'onboard' | 'none';

export type PayoutUi = {
  ready: boolean;
  tone: PayoutTone;
  title: string;
  description: string;
  action: PayoutAction;
};

// Libellés sans jargon Stripe. Fail-closed : tout état non explicitement « prêt » est présenté comme à compléter.
export function derivePayoutUi(account: PayoutAccountState | null): PayoutUi {
  if (account === null) {
    return { ready: false, tone: 'neutral', title: 'Paiements', description: 'Chargement de votre compte de paiement…', action: 'none' };
  }
  if (account.state === 'not_created') {
    return {
      ready: false,
      tone: 'warning',
      title: 'Configurez votre compte avec Stripe',
      description: '',
      action: 'create'
    };
  }
  const staleNote = account.stale ? ' (dernier état connu : connexion indisponible)' : '';
  if (account.ready) {
    return {
      ready: true,
      tone: 'success',
      title: 'Votre compte de paiement est configuré',
      description: '',
      action: 'none'
    };
  }
  if (account.requirements === 'past_due' || account.requirements === 'disabled' || account.transfers === 'restricted') {
    return {
      ready: false,
      tone: 'danger',
      title: 'Action requise',
      description: 'Stripe a besoin d’informations pour activer vos paiements. Vos gains acquis restent dus et seront versés dès que c’est réglé.' + staleNote,
      action: 'onboard'
    };
  }
  if (account.transfers === 'pending') {
    return {
      ready: false,
      tone: 'warning',
      title: 'Vérification en cours',
      description: 'Stripe vérifie vos informations. Cela peut prendre un moment.' + staleNote,
      action: 'onboard'
    };
  }
  return {
    ready: false,
    tone: 'warning',
    title: 'Terminez la configuration',
    description: 'Il reste quelques informations à fournir pour activer vos paiements.' + staleNote,
    action: 'onboard'
  };
}
