export type DispatchOffer = {
  id: string
  orderId: string
  driverId: string
  round: number
  radiusKm: number | null
  status: 'ACTIVE' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED'
  version: number
  expiresAt: Date
  createdAt: Date
  respondedAt: Date | null
}
