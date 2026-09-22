// Outil de test manuel du lecteur SIMULÉ : refuse le premier paiement puis accepte les suivants.
// Inactif par défaut ; ne s'applique que si `__DEV__` ET lecteur simulé (voir use-reader-adapter.ts).
// En build de production `__DEV__` vaut false : le bloc appelant est du code mort.
export const DEV_DECLINE_FIRST_SIMULATED_PAYMENT = false;

export const DECLINED_CARD = '4000000000000002';
export const APPROVED_CARD = '4242424242424242';

// Test manuel « fermeture de l'app pendant l'encaissement » : pause (ms) APRÈS la confirmation du paiement (PI autorisé,
// `requires_capture`) et AVANT l'appel `finalize`, pour laisser le temps de fermer l'app. 0 = désactivé.
export const DEV_PAUSE_AFTER_CONFIRM_MS = 0;
