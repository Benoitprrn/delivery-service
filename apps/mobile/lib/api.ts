import { supabase } from './supabase';
import type { DispatchOffer } from './dispatch-types';
import type { AvailableOrder, DriverHistoryOrder, DriverOrder, DriverProfile, Order } from './orders-types';
import type { ReaderFamily } from './terminal/reader-adapter';
import type { PayoutAccountState, PayoutEntityType, PayoutSessionPurpose } from './payout-types';
import type { DriverSettlementsResponse } from './settlements-types';
import type { MandateStatus, SignedMandate } from './mandate-types';
import type { DocumentSubmissionStatus, DocumentTransmissionStatus } from './document-status';

function requireEnv(name: string, value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const API_URL = requireEnv('EXPO_PUBLIC_API_URL', process.env.EXPO_PUBLIC_API_URL);

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly attemptsRemaining?: number,
    public readonly code?: string
  ) {
    super(message);
  }
}

// Miroir de CompleteOrderCommand['proof'] côté apps/api — voir
// apps/api/src/modules/orders/application/complete-order.ts.
export type DeliveryProof =
  | { method: 'code'; code: string }
  | { method: 'signature'; imageBase64: string }
  | { method: 'photo'; imageBase64: string };

// Miroir de GeoJsonLineString côté apps/api — voir
// apps/api/src/modules/orders/ports/routing-provider.ts. Coordonnées [lng, lat],
// directement consommables par un ShapeSource MapLibre.
export type OrderRouteGeometry = {
  type: 'LineString';
  coordinates: [number, number][];
};

// Miroir de apps/api/src/modules/invoices/ports/invoice-repository.ts (Tranche 5) — voir
// lib/document-status.ts pour la dérivation d'un libellé sans jargon.
export type DriverOrderDocuments = {
  invoices: Array<{ id: string; number: string; issuerKind: 'driver'; invoiceTypeCode: '389'; issuedAt: string; totalHtCents: number; totalVatCents: number; totalTtcCents: number; transmissionStatus: DocumentTransmissionStatus; submissionStatus: DocumentSubmissionStatus; lastError: string | null; facturXAvailable: boolean }>;
  creditNotes: Array<{ id: string; number: string; originalInvoiceNumber: string; issuedAt: string; totalHtCents: number; totalVatCents: number; totalTtcCents: number; transmissionStatus: DocumentTransmissionStatus; submissionStatus: DocumentSubmissionStatus; lastError: string | null; facturXAvailable: boolean }>;
};

// Compte → Mes factures (2026-09-25) : une ligne par facture livreur, tous ordres confondus.
export type DriverInvoiceListItem = { id: string; number: string; orderId: string; orderPublicReference: string; merchantName: string; issuedAt: string; totalHtCents: number; totalVatCents: number; totalTtcCents: number; transmissionStatus: DocumentTransmissionStatus; submissionStatus: DocumentSubmissionStatus; lastError: string | null; facturXAvailable: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Inscription livreur : seul appel public de ce fichier (aucune session au
// moment de l'appel) — bypass request() pour distinguer 201 (compte créé) de
// 202 (issue Auth ambiguë, réservation conservée côté serveur pour
// réconciliation manuelle — voir provision-driver.ts) sans les traiter
// comme un échec puisque fetch() considère les deux comme `ok`.
export type DriverSignupInput = { firstName: string; lastName: string; email: string; phone: string; password: string; termsAccepted: true };
export type DriverSignupResult = { status: 'created'; driverId: string } | { status: 'pending' };

function driverSignupErrorMessage(code: string | undefined, status: number): string {
  if (status === 429) return 'Trop de tentatives, réessayez dans quelques instants.';
  switch (code) {
    case 'ValidationError':
      return 'Vérifiez les informations saisies.';
    case 'AccountAlreadyExistsError':
      return 'Un compte existe déjà avec ces informations. Connectez-vous ou utilisez d’autres coordonnées.';
    case 'DriverProvisioningError':
      return 'Le service d’authentification est momentanément indisponible.';
    default:
      return status >= 500 ? 'La création du compte a échoué, réessayez plus tard.' : 'La création du compte a échoué.';
  }
}

async function driverSignup(input: DriverSignupInput): Promise<DriverSignupResult> {
  const response = await fetch(`${API_URL}/api/v1/auth/driver-signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });
  const body: unknown = await response.json().catch(() => null);

  if (response.status === 201) {
    const driverId = isRecord(body) && typeof body.driverId === 'string' ? body.driverId : undefined;
    if (driverId === undefined) throw new ApiError(500, 'Réponse inattendue du serveur');
    return { status: 'created', driverId };
  }
  if (response.status === 202) {
    return { status: 'pending' };
  }
  const code = isRecord(body) && typeof body.error === 'string' ? body.error : undefined;
  throw new ApiError(response.status, driverSignupErrorMessage(code, response.status), undefined, code);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;

  const headers = new Headers(init?.headers);
  // Fastify refuse (400) un Content-Type JSON sans corps : ne l'annoncer que s'il y a un corps.
  if (init?.body !== undefined && init.body !== null) {
    headers.set('Content-Type', 'application/json');
  }
  if (token !== undefined) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(`${API_URL}${path}`, { ...init, headers });

  if (response.status === 401) {
    // Auparavant silencieux : le signOut() déclenche la navigation retour
    // vers /login avant que l'appelant n'ait la moindre chance d'afficher
    // son propre message d'erreur, donnant l'impression d'un crash sans
    // trace. Ce log est la seule trace qui survit à ce enchaînement.
    console.error(`[api] 401 sur ${path} — déconnexion automatique (JWT invalide/expiré pour ce backend)`);
    await supabase.auth.signOut();
    throw new ApiError(401, 'Session expirée');
  }

  if (!response.ok) {
    let message = `Erreur serveur (${response.status})`;
    let attemptsRemaining: number | undefined;
    let code: string | undefined;
    try {
      const body: unknown = await response.json();
      if (typeof body === 'object' && body !== null) {
        if ('message' in body && typeof body.message === 'string') {
          message = body.message;
        }
        // Code d'erreur stable de l'API (champ `error`), jamais un message brut.
        if ('error' in body && typeof body.error === 'string') {
          code = body.error;
        }
        if ('attemptsRemaining' in body && typeof body.attemptsRemaining === 'number') {
          attemptsRemaining = body.attemptsRemaining;
        }
      }
    } catch {
      // corps non-JSON ou vide — on garde le message générique
    }
    throw new ApiError(response.status, message, attemptsRemaining, code);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> { return request<T>(path, init); }
export async function uploadMultipart<T>(path: string, form: FormData): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const headers = data.session?.access_token === undefined ? {} : { Authorization: `Bearer ${data.session.access_token}` };
  const response = await fetch(`${API_URL}${path}`, { method: 'POST', body: form, headers });
  if (!response.ok) throw new ApiError(response.status, 'Échec de l’envoi du document');
  return response.status === 204 ? undefined as T : await response.json() as T;
}


// --- Finalisation de livraison avec paiement à la livraison (contrat API : docs/work/cod-payment-plan.md, C2b) ---
export type CompletionPayment = {
  id: string;
  status: string;
  amountCents: number;
  currency: 'eur';
  paymentIntentClientSecret: string | null;
  terminalLocationId: string;
  declineCode: string | null;
};

export type CompletionSessionResult =
  | { status: 'completed'; order: Order }
  | { status: 'payment_required'; sessionId: string; payment: CompletionPayment; expiresAt: string };

export type CompletionState = {
  order: { status: Order['status']; version: number };
  session: { id: string; status: string; expiresAt: string } | null;
  payment: CompletionPayment | null;
  nextAction: 'enter_code' | 'collect_payment' | 'finalize' | 'retry_payment' | 'none';
};

export const api = {
  driverSignup,
  getMyDriverProfile: () => request<DriverProfile>('/api/v1/drivers/me'),
  getAvailableOrders: (zoneId: string) =>
    request<AvailableOrder[]>(`/api/v1/orders/available?zoneId=${encodeURIComponent(zoneId)}`),
  getMyOrders: () => request<{ orders: DriverOrder[] }>('/api/v1/orders/driver'),
  getMyOrderHistory: () => request<{ orders: DriverHistoryOrder[] }>('/api/v1/orders/driver/history'),
  getOrderDocuments: (orderId: string) => request<DriverOrderDocuments>(`/api/v1/orders/${orderId}/documents`),
  getMyInvoices: () => request<{ invoices: DriverInvoiceListItem[] }>('/api/v1/drivers/me/invoices'),
  collectOrder: (orderId: string, expectedVersion: number) =>
    request<Order>(`/api/v1/orders/${orderId}/collect`, {
      method: 'POST',
      body: JSON.stringify({ expectedVersion })
    }),
  // Token de connexion Terminal pour la commande (le serveur dérive restaurant, compte Stripe et Location).
  getTerminalConnectionToken: (orderId: string) =>
    request<{ secret: string }>(`/api/v1/orders/${orderId}/terminal/connection-token`, {
      method: 'POST',
      // request() déclare application/json ; Fastify requiert donc un objet JSON explicite.
      body: JSON.stringify({})
    }),
  // Vérifie le code (serveur), puis crée la session et le paiement Terminal. Le mobile n'envoie ni montant, ni compte, ni devise.
  createCompletionSession: (orderId: string, expectedVersion: number, deliveryCode: string, readerFamily: ReaderFamily) =>
    request<CompletionSessionResult>(`/api/v1/orders/${orderId}/delivery-completion-sessions`, {
      method: 'POST',
      body: JSON.stringify({ expectedVersion, deliveryCode, readerFamily })
    }),
  getCompletionState: (orderId: string) => request<CompletionState>(`/api/v1/orders/${orderId}/delivery-completion`),
  // Le serveur relit le PaymentIntent chez Stripe, capture, puis termine la commande : c'est lui qui décide.
  finalizeCompletion: (orderId: string, sessionId: string, paymentId: string) =>
    request<{ status: 'completed'; order: Order }>(`/api/v1/orders/${orderId}/delivery-completion-sessions/${sessionId}/finalize`, {
      method: 'POST',
      body: JSON.stringify({ paymentId })
    }),
  // Carte refusée / paiement abandonné : nouvelle tentative (nouveau PaymentIntent) sans ressaisir le code.
  retryCompletionPayment: (orderId: string, sessionId: string) =>
    request<{ payment: CompletionPayment }>(`/api/v1/orders/${orderId}/delivery-completion-sessions/${sessionId}/retry-payment`, { method: 'POST' }),
  completeOrder: (orderId: string, expectedVersion: number, proof: DeliveryProof) =>
    request<Order>(`/api/v1/orders/${orderId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ expectedVersion, proof })
    }),
  returnOrder: (orderId: string, expectedVersion: number) =>
    request<Order>(`/api/v1/orders/${orderId}/return`, {
      method: 'POST',
      body: JSON.stringify({ expectedVersion })
    }),
  unassignOrder: (orderId: string, expectedVersion: number) =>
    request<Order>(`/api/v1/orders/${orderId}/unassign`, {
      method: 'POST',
      body: JSON.stringify({ expectedVersion })
    }),
  confirmReturn: (orderId: string, expectedVersion: number) =>
    request<Order>(`/api/v1/orders/${orderId}/returned`, {
      method: 'POST',
      body: JSON.stringify({ expectedVersion })
    }),
  recordLocation: (lat: number, lng: number, recordedAt: string) =>
    request<void>('/api/v1/drivers/location', {
      method: 'POST',
      body: JSON.stringify({ lat, lng, recordedAt })
    }),
  disconnectDriver: () => request<void>('/api/v1/drivers/me/disconnect', {
    method: 'POST',
    body: JSON.stringify({})
  }),
  registerPushToken: (token: string) =>
    request<void>('/api/v1/drivers/push-token', {
      method: 'POST',
      body: JSON.stringify({ token })
    }),
  getMySettlements: (limit?: number) =>
    request<DriverSettlementsResponse>(`/api/v1/drivers/me/settlements${limit === undefined ? '' : `?limit=${encodeURIComponent(limit)}`}`),
  // Compte de paiement Stripe du livreur (R30/R31) : le serveur dérive tout ; le mobile ne fournit ni montant ni identifiant Stripe.
  getPayoutAccount: () => request<PayoutAccountState>('/api/v1/drivers/me/payout-account'),
  // Création EXPLICITE ; le type d'entité est choisi une fois et verrouillé (409 EntityTypeLocked ensuite).
  createPayoutAccount: (entityType: PayoutEntityType) =>
    request<PayoutAccountState>('/api/v1/drivers/me/payout-account', { method: 'POST', body: JSON.stringify({ entityType }) }),
  // Repli : lien d'onboarding hébergé, à ouvrir dans le navigateur système (jamais dans une WebView).
  createPayoutOnboardingLink: () =>
    request<{ url: string; expiresAt: string }>('/api/v1/drivers/me/payout-account/onboarding-link', { method: 'POST' }),
  // Secret d'une Account Session pour les composants Stripe embarqués ; jamais stocké ni journalisé.
  createPayoutAccountSession: (purpose: PayoutSessionPurpose) =>
    request<{ clientSecret: string; expiresAt: string }>('/api/v1/drivers/me/payout-account/account-session', {
      method: 'POST',
      body: JSON.stringify({ purpose })
    }),
  createPayoutDashboardLink: () =>
    request<{ url: string }>('/api/v1/drivers/me/payout-account/dashboard-link', { method: 'POST' }),
  setAvailability: (available: boolean, position?: { lat: number; lng: number }) =>
    request<{ available: boolean }>('/api/v1/drivers/availability', {
      method: 'POST',
      // Déstructuration explicite plutôt qu'un spread de `position` : ce
      // dernier vient de getCurrentPositionOrNull() (lib/gps.ts), qui porte
      // aussi un champ `timestamp` — TypeScript ne signale pas les
      // propriétés en trop d'une variable (seulement d'un littéral), donc ce
      // champ passait silencieusement jusqu'au serveur, dont le schema Zod
      // `.strict()` rejette toute clé inconnue avec un 400 générique.
      body: JSON.stringify(
        position === undefined ? { available } : { available, lat: position.lat, lng: position.lng }
      )
    }),
  // `request` envoie toujours Content-Type: application/json. Fastify refuse
  // un corps JSON absent avec cet en-tête, donc le heartbeat transmet un objet vide.
  sendAvailabilityHeartbeat: () => request<void>('/api/v1/drivers/heartbeat', {
    method: 'POST',
    body: JSON.stringify({})
  }),
  getOrderRoute: (orderId: string) =>
    request<{ geometry: OrderRouteGeometry }>(`/api/v1/orders/${orderId}/route`),
  getDispatchOffer: (offerId: string) =>
    request<{ offer: DispatchOffer; order: DriverOrder }>(`/api/v1/dispatch-offers/${offerId}`),
  acceptDispatchOffer: (offerId: string, expectedVersion: number) =>
    request<void>(`/api/v1/dispatch-offers/${offerId}/accept`, {
      method: 'POST',
      body: JSON.stringify({ expectedVersion })
    }),
  rejectDispatchOffer: (offerId: string, expectedVersion: number) =>
    request<void>(`/api/v1/dispatch-offers/${offerId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ expectedVersion })
    }),
  // Mandat de facturation électronique (Tranche 4c) : lecture d'état (statut, aperçu du texte
  // prérempli tant que non signé), acceptation (le serveur fige tout — snapshot, PDF, preuve —
  // dans une seule transaction locale ; aucun appel Super PDP dans cette requête, voir Tranche 4b),
  // URL signée courte du PDF déjà signé.
  getMandateStatus: () => request<MandateStatus>('/api/v1/drivers/me/einvoice-mandate'),
  acceptMandate: (signatureImageBase64: string, signerFirstName: string, signerLastName: string) =>
    request<SignedMandate>('/api/v1/drivers/me/einvoice-mandate', {
      method: 'POST',
      body: JSON.stringify({ signatureImageBase64, signerFirstName, signerLastName })
    }),
  getMandatePdfUrl: () => request<{ url: string }>('/api/v1/drivers/me/einvoice-mandate/pdf-url'),
  // URL signée courte durée du Factur-X d'une facture/avoir (Tranche 5) — jamais persistée,
  // demandée à l'ouverture seulement.
  getInvoiceDocumentFacturXUrl: (orderId: string, documentId: string, kind: 'invoice' | 'credit_note') =>
    request<{ url: string }>(`/api/v1/orders/${orderId}/documents/${documentId}/factur-x?kind=${kind}`)
};
