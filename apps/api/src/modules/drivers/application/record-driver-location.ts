import type { DriverLocationRepository } from '../ports/driver-location-repository.js'
import type { DriverPositionRepository } from '../ports/driver-position-repository.js'
import type { ActiveOrderTrackingReader } from '../../orders/public.js'

export type TrackingPositionEmitter = {
  emitTrackingPosition(trackingToken: string, position: { lat: number; lng: number }): void
}

export type RecordDriverLocationCommand = {
  driverId: string
  lat: number
  lng: number
  recordedAt: Date
}

const DRIVER_LOCATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

export class RecordDriverLocationUseCase {
  public constructor(
    private readonly repository: Pick<DriverLocationRepository, 'record'>,
    private readonly positions: DriverPositionRepository,
    private readonly activeOrders: ActiveOrderTrackingReader = { findActiveTrackingTokensByDriverId: async () => [] },
    private readonly emitter: TrackingPositionEmitter = { emitTrackingPosition: () => undefined }
  ) {}

  public async execute(command: RecordDriverLocationCommand): Promise<void> {
    await this.positions.record(command.driverId, { lat: command.lat, lng: command.lng }, command.recordedAt)
    let tokens: readonly string[] = []
    try {
      tokens = await this.activeOrders.findActiveTrackingTokensByDriverId(command.driverId)
    } catch {
      // Active-order lookup is non-critical after the current position is stored.
    }
    const hasActiveOrder = tokens.length > 0

    // Align driver GPS retention with the seven-day proof dispute window.
    if (hasActiveOrder) {
      await this.repository.record({
        ...command,
        expiresAt: new Date(command.recordedAt.getTime() + DRIVER_LOCATION_RETENTION_MS)
      })
    }
    if (!hasActiveOrder) return

    // Persistence has succeeded. Socket delivery is best-effort and can never
    // turn a successful GPS write into an HTTP failure.
    try {
      for (const token of tokens) this.emitter.emitTrackingPosition(token, { lat: command.lat, lng: command.lng })
    } catch {
      // Technical realtime fanout is intentionally non-critical.
    }
  }
}
