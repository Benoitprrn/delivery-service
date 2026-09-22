// Miroir de PayoutAccountView côté apps/api — voir
// apps/api/src/modules/settlements/application/driver-payout-account.ts. Jamais d'identifiant Stripe côté mobile.
export type PayoutEntityType = 'individual' | 'company';
export type PayoutCapabilityState = 'inactive' | 'pending' | 'active' | 'restricted' | 'unknown';
export type PayoutRequirementsState = 'none' | 'eventually_due' | 'currently_due' | 'past_due' | 'disabled';

export type PayoutAccountState =
  | { state: 'not_created' }
  | {
    state: 'created';
    entityType: PayoutEntityType;
    ready: boolean;
    actionRequired: boolean;
    transfers: PayoutCapabilityState;
    requirements: PayoutRequirementsState;
    stale: boolean;
  };

export type PayoutSessionPurpose = 'onboarding' | 'wallet';
