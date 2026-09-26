export const GROUPAGE_WINDOW_MINUTES = 30

export type DispatchAttempt = {
  driverId: string
  // 'driver_cancelled' : le livreur avait accepté la course puis l'a annulée avant collecte
  // (ASSIGNED -> AVAILABLE) — exclusion définitive de cette course pour ce livreur, jamais
  // une simple pénalité temporaire comme 'refused'/'timeout'.
  reason: 'refused' | 'timeout' | 'driver_cancelled'
  round: number
  refusedAt: string
}

export type DispatchMetadata = {
  dispatchAttempts: DispatchAttempt[]
  dispatchRadiusKm: number | null
  dispatchFailed: boolean
}
