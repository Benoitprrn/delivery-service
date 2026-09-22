import { supabase } from './supabase';
import type { DispatchOffer } from './dispatch-types';
import type { AvailableOrder, DriverHistoryOrder, DriverOrder, DriverProfile, Order } from './orders-types';
import type { ReaderFamily } from './terminal/reader-adapter';
import type { PayoutAccountState, PayoutEntityType, PayoutSessionPurpose } from './payout-types';
import type { DriverEarnings } from './wallet-types';
import type { DriverSettlementsResponse } from './settlements-types';

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
  getMyDriverProfile: () => request<DriverProfile>('/api/v1/drivers/me'),
  getAvailableOrders: (zoneId: string) =>
    request<AvailableOrder[]>(`/api/v1/orders/available?zoneId=${encodeURIComponent(zoneId)}`),
  getMyOrders: () => request<{ orders: DriverOrder[] }>('/api/v1/orders/driver'),
  getMyOrderHistory: () => request<{ orders: DriverHistoryOrder[] }>('/api/v1/orders/driver/history'),
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
  getMyEarnings: () => request<DriverEarnings>('/api/v1/orders/driver/earnings'),
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
    })
};
