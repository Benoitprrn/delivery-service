import { supabase } from './supabase';
import type { DispatchOffer } from './dispatch-types';
import type { AvailableOrder, DriverHistoryOrder, DriverOrder, DriverProfile, Order } from './orders-types';
import type { DriverEarnings } from './wallet-types';

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
    public readonly attemptsRemaining?: number
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
  headers.set('Content-Type', 'application/json');
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
    try {
      const body: unknown = await response.json();
      if (typeof body === 'object' && body !== null) {
        if ('message' in body && typeof body.message === 'string') {
          message = body.message;
        }
        if ('attemptsRemaining' in body && typeof body.attemptsRemaining === 'number') {
          attemptsRemaining = body.attemptsRemaining;
        }
      }
    } catch {
      // corps non-JSON ou vide — on garde le message générique
    }
    throw new ApiError(response.status, message, attemptsRemaining);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export const api = {
  getMyDriverProfile: () => request<DriverProfile>('/api/v1/drivers/me'),
  getAvailableOrders: (zoneId: string) =>
    request<AvailableOrder[]>(`/api/v1/orders/available?zoneId=${encodeURIComponent(zoneId)}`),
  getMyOrders: () => request<{ orders: DriverOrder[] }>('/api/v1/orders/driver'),
  getMyOrderHistory: () => request<{ orders: DriverHistoryOrder[] }>('/api/v1/orders/driver/history'),
  assignOrder: (orderId: string, expectedVersion: number) =>
    request<Order>(`/api/v1/orders/${orderId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ expectedVersion })
    }),
  collectOrder: (orderId: string, expectedVersion: number) =>
    request<Order>(`/api/v1/orders/${orderId}/collect`, {
      method: 'POST',
      body: JSON.stringify({ expectedVersion })
    }),
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
