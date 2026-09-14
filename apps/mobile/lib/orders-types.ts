// Miroir de apps/api/src/modules/orders/domain/{order,order-status}.ts — pas
// encore de type partagé dans packages/shared (vide jusqu'à l'étape 7 du
// contrat API), donc dupliqué ici volontairement plutôt qu'importé à
// travers les workspaces.
export type OrderStatus =
  | 'CREATED'
  | 'AVAILABLE'
  | 'ASSIGNED'
  | 'COLLECTED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'RETURNING'
  | 'RETURNED';

export type Order = {
  id: string;
  merchantId: string;
  driverId: string | null;
  zoneId: string;
  status: OrderStatus;
  version: number;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  pickupScheduledAt: string | null;
  orderDetails: string | null;
  deliveryInstructions: string | null;
  deliveryAddressComplement: string | null;
  pickupAddress: string;
  pickupLat: number;
  pickupLng: number;
  deliveryAddress: string;
  deliveryLat: number;
  deliveryLng: number;
  distanceM: number;
  durationS: number;
  priceCents: number;
  assignedAt: string | null;
  collectedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

// Projection destinée aux livreurs : l'identité du destinataire est masquée
// avant la collecte, alors que les coordonnées du commerce restent visibles.
export type DriverOrder = Omit<Order, 'customerName' | 'customerPhone'> & {
  customerName: string | null;
  customerPhone: string | null;
  merchantName: string;
  merchantPhone: string | null;
};

export type DriverHistoryOrder = DriverOrder & {
  driverEarningCents: number;
};

export type AvailableOrder = DriverOrder;

export type DriverProfile = {
  id: string;
  name: string;
  zoneId: string;
  isAvailable: boolean;
};
