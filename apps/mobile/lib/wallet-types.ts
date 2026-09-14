// Miroir de GET /api/v1/orders/driver/earnings — voir
// apps/api/src/modules/orders/domain/driver-earnings.ts. Gains provisoires
// uniquement, aucun vrai flux de paiement (payments/ reste un stub côté
// backend) : le virement se fait hors app, manuellement.
export type CompletedOrderEarning = {
  id: string;
  completedAt: string;
  earningCents: number;
  deliveryAddress: string;
};

export type DriverEarnings = {
  totalEarningCents: number;
  completedOrderCount: number;
  currency: 'EUR';
  paymentMethod: 'bank_transfer';
  paymentStatus: 'provisional';
  recentCompletedOrders: CompletedOrderEarning[];
};
