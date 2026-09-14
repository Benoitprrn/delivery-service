// Stub — contenu (domain/application/ports/infrastructure/transport) ajouté à l'étape 3.
import type { Pool } from 'pg'
import type Redis from 'ioredis'
import { RecordDriverLocationUseCase } from './application/record-driver-location.js'
import { SetDriverAvailabilityUseCase } from './application/set-driver-availability.js'
import { HeartbeatDriverAvailabilityUseCase } from './application/heartbeat-driver-availability.js'
import { GetDriverLiveProfileUseCase } from './application/get-driver-live-profile.js'
import { PostgresDriverLocationRepository } from './infrastructure/postgres-driver-location-repository.js'
import { PostgresDriverRepository } from './infrastructure/postgres-driver-repository.js'
import { ValkeyDriverAvailabilityRepository } from './infrastructure/valkey-driver-availability-repository.js'
import type { DriverAvailabilityRepository } from './ports/driver-availability-repository.js'
export { registerDriverHttpRoutes } from './transport/http/routes.js'

export type { Driver } from './domain/driver.js'
export type { DriverLocation } from './domain/driver-location.js'

export function createDriversModule(
  pool: Pool,
  valkey?: Redis,
  syncDriverPresence: (driverId: string, available: boolean) => Promise<void> | void = () => undefined
) {
  const repository = new PostgresDriverRepository(pool)
  const locationRepository = new PostgresDriverLocationRepository(pool)
  const availabilityRepository: DriverAvailabilityRepository = valkey === undefined
    ? {
        set: async () => { throw new Error('Driver availability requires Valkey') },
        get: async () => false,
        refresh: async () => false
      }
    : new ValkeyDriverAvailabilityRepository(valkey)
  const recordDriverLocationUseCase = new RecordDriverLocationUseCase(locationRepository)
  const setDriverAvailabilityUseCase = new SetDriverAvailabilityUseCase(availabilityRepository, syncDriverPresence)
  const heartbeatDriverAvailabilityUseCase = new HeartbeatDriverAvailabilityUseCase(availabilityRepository)
  const getDriverLiveProfileUseCase = new GetDriverLiveProfileUseCase(repository, availabilityRepository)

  return {
    findDriverById: repository.findById.bind(repository),
    recordLocation: recordDriverLocationUseCase.execute.bind(recordDriverLocationUseCase),
    setAvailability: setDriverAvailabilityUseCase.execute.bind(setDriverAvailabilityUseCase),
    heartbeat: heartbeatDriverAvailabilityUseCase.execute.bind(heartbeatDriverAvailabilityUseCase),
    isAvailable: availabilityRepository.get.bind(availabilityRepository),
    getLiveDriverProfile: getDriverLiveProfileUseCase.execute.bind(getDriverLiveProfileUseCase)
  }
}
