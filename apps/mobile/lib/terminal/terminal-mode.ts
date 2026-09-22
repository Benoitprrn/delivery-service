import type { ReaderFamily } from './reader-adapter';

// Le lecteur simulé remplace UNIQUEMENT le matériel (Stripe, PaymentIntent,
// Connect, capture et logique métier restent réels). Il est interdit dans un
// build de production : le serveur le refuse aussi hors Sandbox.
export function resolveReaderFamily(): ReaderFamily {
  const mode = process.env.EXPO_PUBLIC_TERMINAL_MODE ?? 'physical';
  if (mode === 'simulated') {
    if (!__DEV__ && process.env.EXPO_PUBLIC_ALLOW_SIMULATED_READER !== 'true') {
      throw new Error('Le lecteur Terminal simulé est interdit dans un build de production.');
    }
    return 'simulated_bluetooth';
  }
  return 'bluetooth';
}
