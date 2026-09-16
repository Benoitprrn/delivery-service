export type DispatchAttempt = {
  driverId: string
  reason: 'refused' | 'timeout'
  round: number
  refusedAt: string
}

export type DispatchMetadata = {
  dispatchAttempts: DispatchAttempt[]
  dispatchRadiusKm: number | null
  dispatchFailed: boolean
}
