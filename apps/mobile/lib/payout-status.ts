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
      title: 'Configurez vos paiements',
      description: 'Pour voir des courses et être payé, créez votre compte de paiement sécurisé (Stripe).',
      action: 'create'
    };
  }
  const staleNote = account.stale ? ' (dernier état connu : connexion indisponible)' : '';
  if (account.ready) {
    const upcoming = account.requirements === 'eventually_due' || account.requirements === 'currently_due';
    return {
      ready: true,
      tone: 'success',
      title: 'Paiements prêts',
      description: (upcoming
        ? 'Vous pouvez prendre des courses. Stripe pourra vous demander une pièce justificative : gardez l’application à jour.'
        : 'Vous pouvez prendre des courses et recevoir vos versements.') + staleNote,
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
