import type Redis from 'ioredis'
import type { DriverPositionRepository } from '../ports/driver-position-repository.js'

const TTL_SECONDS = 300
const POSITION_IDS_KEY = 'drivers:position_ids'

function currentPositionKey(driverId: string): string {
  return `driver:{${driverId}}:current_position`
}

function lastKnownPositionKey(driverId: string): string {
  return `driver:{${driverId}}:last_known_position`
}

const RECORD_POSITION_SCRIPT = `
local existing = redis.call('GET', KEYS[2])
if existing then
  local ok, parsed = pcall(cjson.decode, existing)
  if ok and parsed.recordedAt and parsed.recordedAt > ARGV[2] then
    -- Out-of-order write (older than what we already hold): register the
    -- driver in the dispatch index so a first-ever write is never lost, but
    -- skip both position keys. current_position must never regress to a
    -- stale value either, not just last_known_position.
    redis.call('SADD', KEYS[3], ARGV[4])
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[1])
redis.call('SADD', KEYS[3], ARGV[4])
return 1
`

const CLEAR_POSITION_SCRIPT = `
redis.call('DEL', KEYS[1], KEYS[2])
redis.call('SREM', KEYS[3], ARGV[1])
return 1
`

function distanceInMeters(origin: { lat: number; lng: number }, destination: { lat: number; lng: number }): number {
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180
  const latitudeDelta = toRadians(destination.lat - origin.lat)
  const longitudeDelta = toRadians(destination.lng - origin.lng)
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(origin.lat)) * Math.cos(toRadians(destination.lat)) * Math.sin(longitudeDelta / 2) ** 2
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
}

export class ValkeyDriverPositionRepository implements DriverPositionRepository {
  public constructor(private readonly client: Redis) {}

  public async record(driverId: string, position: { lat: number; lng: number }, recordedAt: Date): Promise<void> {
    const recordedAtIso = recordedAt.toISOString()
    const payload = JSON.stringify({ ...position, recordedAt: recordedAtIso })
    // The two per-driver keys share a hash tag. The global index intentionally
    // remains a single key for efficient dispatch on the current standalone Valkey;
    // a future cluster deployment must partition that index before this script can run cross-slot.
    await this.client.eval(
      RECORD_POSITION_SCRIPT,
      3,
      currentPositionKey(driverId),
      lastKnownPositionKey(driverId),
      POSITION_IDS_KEY,
      payload,
      recordedAtIso,
      String(TTL_SECONDS),
      driverId
    )
  }

  public async clear(driverId: string): Promise<void> {
    await this.client.eval(
      CLEAR_POSITION_SCRIPT,
      3,
      currentPositionKey(driverId),
      lastKnownPositionKey(driverId),
      POSITION_IDS_KEY,
      driverId
    )
  }

  public async findAllWithinRadius(
    center: { lat: number; lng: number },
    radiusKm: number,
    excludeDriverIds: readonly string[]
  ): Promise<{ driverId: string; lat: number; lng: number }[]> {
    const driverIds = await this.client.smembers(POSITION_IDS_KEY)
    if (driverIds.length === 0) return []

    const keys = driverIds.flatMap((driverId) => [currentPositionKey(driverId), lastKnownPositionKey(driverId)])
    const values = await this.client.mget(...keys)
    const excluded = new Set(excludeDriverIds)
    const radiusM = radiusKm * 1_000
    const positions: { driverId: string; lat: number; lng: number }[] = []

    for (const [index, driverId] of driverIds.entries()) {
      if (excluded.has(driverId)) continue
      const value = values[index * 2] ?? values[index * 2 + 1]
      if (value === null || value === undefined) continue
      try {
        const parsed: unknown = JSON.parse(value)
        if (
          typeof parsed !== 'object' || parsed === null ||
          !('lat' in parsed) || !('lng' in parsed) ||
          typeof parsed.lat !== 'number' || typeof parsed.lng !== 'number'
        ) continue
        const position = { driverId, lat: parsed.lat, lng: parsed.lng }
        if (distanceInMeters(center, position) <= radiusM) positions.push(position)
      } catch {
        // A malformed cache value is ignored and will be replaced by the next GPS update.
      }
    }
    return positions
  }
}
