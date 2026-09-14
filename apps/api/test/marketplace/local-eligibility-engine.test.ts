import { describe, expect, it } from 'vitest'
import { LocalEligibilityEngine } from '../../src/modules/marketplace/application/local-eligibility-engine.js'
import { AlwaysHasDriverCapacity } from '../../src/modules/marketplace/infrastructure/always-has-driver-capacity.js'
import type { DriverId } from '../../src/modules/marketplace/domain/driver-id.js'
import type { DriverAvailabilityReader } from '../../src/modules/marketplace/ports/driver-availability-reader.js'
import type { DriverCapacityReader } from '../../src/modules/marketplace/ports/driver-capacity-reader.js'
import type { ZoneConnectionReader } from '../../src/modules/marketplace/ports/zone-connection-reader.js'
import type { ZoneRoomMembershipManager } from '../../src/modules/marketplace/ports/zone-room-membership-manager.js'

const input = { orderId: 'order-1', zoneId: 'zone-1' }

function createEngine(
  connectedDriverIds: readonly DriverId[],
  available: Record<DriverId, boolean> = {},
  hasCapacity: Record<DriverId, boolean> = {},
  calls: string[] = []
): LocalEligibilityEngine {
  const zoneConnections: ZoneConnectionReader = {
    getConnectedDriverIds: async (zoneId) => {
      calls.push(`zone:${zoneId}`)
      return connectedDriverIds
    }
  }
  const availability: DriverAvailabilityReader = {
    isAvailable: async (driverId) => {
      calls.push(`availability:${driverId}`)
      return available[driverId] ?? false
    }
  }
  const capacity: DriverCapacityReader = {
    hasCapacity: async (driverId) => {
      calls.push(`capacity:${driverId}`)
      return hasCapacity[driverId] ?? false
    }
  }
  const zoneMembership: ZoneRoomMembershipManager = {
    removeDriverFromZone: async (driverId, zoneId) => {
      calls.push(`remove:${driverId}:${zoneId}`)
    }
  }
  return new LocalEligibilityEngine(zoneConnections, availability, capacity, zoneMembership)
}

describe('LocalEligibilityEngine', () => {
  it('does not evaluate availability or capacity when the zone has no candidates', async () => {
    const calls: string[] = []
    const engine = createEngine([], {}, {}, calls)

    await expect(engine.getEligibleDrivers(input)).resolves.toEqual([])
    expect(calls).toEqual(['zone:zone-1'])
  })

  it('evaluates only drivers connected to the requested zone', async () => {
    const calls: string[] = []
    const engine = createEngine(['in-zone'], { 'in-zone': true }, { 'in-zone': true }, calls)

    await expect(engine.getEligibleDrivers(input)).resolves.toEqual(['in-zone'])
    expect(calls).toEqual(['zone:zone-1', 'availability:in-zone', 'capacity:in-zone'])
  })

  it('excludes unavailable drivers, removes them from the room, and skips capacity', async () => {
    const calls: string[] = []
    const engine = createEngine(['offline'], { offline: false }, { offline: true }, calls)

    await expect(engine.getEligibleDrivers(input)).resolves.toEqual([])
    expect(calls).toEqual(['zone:zone-1', 'availability:offline', 'remove:offline:zone-1'])
  })

  it('checks capacity after availability and excludes drivers without capacity without removing them', async () => {
    const calls: string[] = []
    const engine = createEngine(['full'], { full: true }, { full: false }, calls)

    await expect(engine.getEligibleDrivers(input)).resolves.toEqual([])
    expect(calls).toEqual(['zone:zone-1', 'availability:full', 'capacity:full'])
  })

  it('deduplicates drivers with multiple sockets', async () => {
    const calls: string[] = []
    const engine = createEngine(['same-driver', 'same-driver'], { 'same-driver': true }, { 'same-driver': true }, calls)

    await expect(engine.getEligibleDrivers(input)).resolves.toEqual(['same-driver'])
    expect(calls).toEqual(['zone:zone-1', 'availability:same-driver', 'capacity:same-driver'])
  })

  it('applies the zone, availability, and capacity filters in strict order', async () => {
    const calls: string[] = []
    const engine = createEngine(['available', 'unavailable'], { available: true, unavailable: false }, { available: true }, calls)

    await expect(engine.getEligibleDrivers(input)).resolves.toEqual(['available'])
    expect(calls).toEqual([
      'zone:zone-1',
      'availability:available',
      'availability:unavailable',
      'remove:unavailable:zone-1',
      'capacity:available'
    ])
  })

  it('propagates errors raised by a port', async () => {
    const failingConnections: ZoneConnectionReader = {
      getConnectedDriverIds: async () => { throw new Error('zone connection failure') }
    }
    const availability: DriverAvailabilityReader = { isAvailable: async () => true }
    const capacity: DriverCapacityReader = { hasCapacity: async () => true }
    const membership: ZoneRoomMembershipManager = { removeDriverFromZone: async () => undefined }
    const engine = new LocalEligibilityEngine(failingConnections, availability, capacity, membership)

    await expect(engine.getEligibleDrivers(input)).rejects.toThrow('zone connection failure')
  })
})

describe('AlwaysHasDriverCapacity', () => {
  it('always returns true', async () => {
    const capacity = new AlwaysHasDriverCapacity()

    await expect(capacity.hasCapacity('any-driver')).resolves.toBe(true)
  })
})
