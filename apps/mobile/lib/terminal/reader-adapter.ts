// Abstraction du lecteur Stripe Terminal. Le métier (écran de finalisation, API)
// ne connaît que ce contrat : passer du lecteur simulé au WisePad 3 réel ne doit
// changer que la famille résolue par `resolveReaderFamily()`.
//
// Le mobile ne crée JAMAIS de PaymentIntent, de token, de montant, de compte ni
// de capture : il collecte et confirme le PaymentIntent (client secret) que le
// serveur lui remet, puis le serveur relit Stripe, capture et finalise.

export type ReaderFamily = 'simulated_bluetooth' | 'bluetooth' | 'usb' | 'internet';

export type ReaderPhase = 'idle' | 'discovering' | 'connecting' | 'updating' | 'connected' | 'collecting' | 'confirming';

export type ReaderStatus = { phase: ReaderPhase; updateProgress?: number };

export type ReaderErrorKind =
  | 'permission_denied'
  | 'reader_not_found'
  | 'multiple_readers'
  | 'battery_low'
  | 'update_failed'
  | 'token_error'
  | 'card_declined'
  | 'collect_canceled'
  | 'network'
  | 'unknown';

export class ReaderError extends Error {
  constructor(
    public readonly kind: ReaderErrorKind,
    message: string,
    public readonly code?: string
  ) {
    super(message);
  }
}

export interface ReaderAdapter {
  readonly family: ReaderFamily;
  /**
   * Repart TOUJOURS d'un contexte propre (déconnexion + effacement des
   * identifiants en cache) puis découvre, annule la découverte et connecte le
   * lecteur à la Location du restaurant. Changer de restaurant = rappeler connect.
   */
  connect(input: { locationId: string; readerSerial?: string }): Promise<{ serial: string | null }>;
  /** Collecte puis confirme ; résout quand le PaymentIntent est autorisé (`requires_capture`). */
  collectAndConfirm(paymentIntentClientSecret: string): Promise<{ status: 'requires_capture' }>;
  cancelCollection(): Promise<void>;
  /** Ne pas l'appeler pour « économiser la batterie » : réservé au changement de restaurant et à la fin de session. */
  disconnect(): Promise<void>;
  clearCredentials(): Promise<void>;
}
