// Miroir de apps/api/src/modules/dispatch/domain/dispatch-offer.ts — même
// raison que orders-types.ts : pas de type partagé cross-workspace encore.
export type DispatchOfferStatus = 'ACTIVE' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';

export type DispatchOffer = {
  id: string;
  orderId: string;
  driverId: string;
  round: number;
  radiusKm: number | null;
  status: DispatchOfferStatus;
  version: number;
  expiresAt: string;
  createdAt: string;
  respondedAt: string | null;
};

// Payload de l'événement socket dispatch_offer_created (voir
// apps/api/src/realtime/socket-handler.ts) — pas le détail commande, juste
// de quoi identifier l'offre et démarrer le compte à rebours immédiatement,
// le détail est chargé séparément via api.getDispatchOffer.
export type DispatchOfferCreatedPayload = {
  offerId: string;
  orderId: string;
  driverId: string;
  round: number;
  radiusKm: number | null;
  expiresAt: string;
};
