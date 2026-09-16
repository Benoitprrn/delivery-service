// Stub — contenu (domain/application/ports/infrastructure/transport) ajouté à l'étape 3.
import type { Pool } from 'pg'
import type Redis from 'ioredis'
import { RecordDriverLocationUseCase } from './application/record-driver-location.js'
import { SetDriverAvailabilityUseCase } from './application/set-driver-availability.js'
import { DisconnectDriverUseCase } from './application/disconnect-driver.js'
import { HeartbeatDriverAvailabilityUseCase } from './application/heartbeat-driver-availability.js'
import { GetDriverLiveProfileUseCase } from './application/get-driver-live-profile.js'
import { RegisterDriverPushTokenUseCase } from './application/register-driver-push-token.js'
import { GetDriverCapacityUseCase } from './application/get-driver-capacity.js'
import { PostgresDriverLocationRepository } from './infrastructure/postgres-driver-location-repository.js'
import { PostgresDriverRepository } from './infrastructure/postgres-driver-repository.js'
import { ValkeyDriverAvailabilityRepository } from './infrastructure/valkey-driver-availability-repository.js'
import { ValkeyDriverCapacityRepository } from './infrastructure/valkey-driver-capacity-repository.js'
import { ValkeyDriverPositionRepository } from './infrastructure/valkey-driver-position-repository.js'
import type { DriverAvailabilityRepository } from './ports/driver-availability-repository.js'
import type { DriverCapacityRepository } from './ports/driver-capacity-repository.js'
import type { DriverPositionRepository } from './ports/driver-position-repository.js'
import type { ActiveOrderTrackingReader } from '../orders/public.js'
import type { TrackingPositionEmitter } from './application/record-driver-location.js'
export { registerDriverHttpRoutes } from './transport/http/routes.js'

export type { Driver } from './domain/driver.js'
export type { DriverLocation } from './domain/driver-location.js'

export function createDriversModule(
  pool: Pool,
  valkey?: Redis,
  syncDriverPresence: (driverId: string, available: boolean) => Promise<void> | void = () => undefined,
  tracking?: { activeOrders: ActiveOrderTrackingReader; emitter: TrackingPositionEmitter }
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
  const capacityRepository: DriverCapacityRepository = valkey === undefined
    ? {
        increment: async () => { throw new Error('Driver capacity requires Valkey') },
        decrement: async () => { throw new Error('Driver capacity requires Valkey') },
        get: async () => null,
        set: async () => { throw new Error('Driver capacity requires Valkey') }
      }
    : new ValkeyDriverCapacityRepository(valkey)
  const positionRepository: DriverPositionRepository = valkey === undefined
    ? {
        record: async () => { throw new Error('Driver positions require Valkey') },
        clear: async () => { throw new Error('Driver positions require Valkey') },
        findAllWithinRadius: async () => { throw new Error('Driver positions require Valkey') }
      }
    : new ValkeyDriverPositionRepository(valkey)
  const recordDriverLocationUseCase = new RecordDriverLocationUseCase(
    locationRepository,
    positionRepository,
    tracking?.activeOrders,
    tracking?.emitter
  )
  const setDriverAvailabilityUseCase = new SetDriverAvailabilityUseCase(availabilityRepository, syncDriverPresence)
  const disconnectDriverUseCase = new DisconnectDriverUseCase(availabilityRepository, positionRepository, syncDriverPresence)
  const heartbeatDriverAvailabilityUseCase = new HeartbeatDriverAvailabilityUseCase(availabilityRepository)
  const getDriverLiveProfileUseCase = new GetDriverLiveProfileUseCase(repository, availabilityRepository)
  const registerDriverPushTokenUseCase = new RegisterDriverPushTokenUseCase(repository)
  const getDriverCapacityUseCase = new GetDriverCapacityUseCase(capacityRepository, tracking?.activeOrders)

  return {
    findDriverById: repository.findById.bind(repository),
    findDriverIdsByZoneId: repository.findIdsByZoneId.bind(repository),
    findPushTokensByDriverIds: repository.findPushTokensByDriverIds.bind(repository),
    registerPushToken: registerDriverPushTokenUseCase.execute.bind(registerDriverPushTokenUseCase),
    recordLocation: recordDriverLocationUseCase.execute.bind(recordDriverLocationUseCase),
    setAvailability: setDriverAvailabilityUseCase.execute.bind(setDriverAvailabilityUseCase),
    disconnect: disconnectDriverUseCase.execute.bind(disconnectDriverUseCase),
    heartbeat: heartbeatDriverAvailabilityUseCase.execute.bind(heartbeatDriverAvailabilityUseCase),
    isAvailable: availabilityRepository.get.bind(availabilityRepository),
    incrementCapacity: capacityRepository.increment.bind(capacityRepository),
    decrementCapacity: capacityRepository.decrement.bind(capacityRepository),
    getCapacity: getDriverCapacityUseCase.execute.bind(getDriverCapacityUseCase),
    findAvailableWithinRadius: positionRepository.findAllWithinRadius.bind(positionRepository),
    findLatestDriverLocation: locationRepository.findLatestByDriverId.bind(locationRepository),
    getLiveDriverProfile: getDriverLiveProfileUseCase.execute.bind(getDriverLiveProfileUseCase)
  }
}
