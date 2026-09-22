import { afterEach, describe, expect, it, vi } from 'vitest'
import { VroomDispatchPlanner } from '../../src/modules/dispatch/infrastructure/vroom-dispatch-planner.js'
import type { DispatchDeliveryJob, DispatchPlannerInput, DispatchShipment } from '../../src/modules/dispatch/ports/dispatch-planner.js'

const restaurant = { lat: 46.2058, lng: 5.2255 }
const customer = { lat: 46.21, lng: 5.23 }

function shipment(orderId: string, pickupScheduledAt: Date, durationS = 600): DispatchShipment {
  return {
    orderId,
    pickupLocation: restaurant,
    deliveryLocation: customer,
    pickupScheduledAt,
    deliveryWindowStart: new Date(pickupScheduledAt.getTime() + durationS * 1_000)
  }
}

function deliveryJob(orderId: string, deliveryLocation: { lat: number; lng: number }, deliveryWindowStart: Date): DispatchDeliveryJob {
  return { orderId, deliveryLocation, deliveryWindowStart }
}

function input(
  existingShipments: readonly DispatchShipment[] = [],
  existingDeliveryJobs: readonly DispatchDeliveryJob[] = []
): DispatchPlannerInput {
  return {
    driver: { id: 'driver-1', location: { lat: 46.2, lng: 5.22 } },
    existingShipments,
    existingDeliveryJobs,
    candidateShipment: shipment('candidate', new Date('2035-01-01T12:00:00.000Z'))
  }
}

function successfulVroomResponse(): Response {
  return new Response(JSON.stringify({ unassigned: [], routes: [{ steps: [] }] }), { status: 200 })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('VroomDispatchPlanner payload', () => {
  it('uses a five-minute pickup window, 60-second service, a unit amount, and vehicle capacity two', async () => {
    let requestBody: BodyInit | null | undefined
    vi.stubGlobal('fetch', async (_url: string | URL, options?: RequestInit) => {
      requestBody = options?.body
      return successfulVroomResponse()
    })

    await new VroomDispatchPlanner('http://vroom.test').checkFeasibility(input())

    const body = JSON.parse(String(requestBody)) as {
      vehicles: { capacity: number[] }[]
      shipments: { amount: number[]; pickup: { service: number; time_windows: number[][] } }[]
    }
    expect(body.vehicles[0]?.capacity).toEqual([2])
    expect(body.shipments[0]?.amount).toEqual([1])
    expect(body.shipments[0]?.pickup.service).toBe(60)
    expect(body.shipments[0]?.pickup.time_windows).toEqual([[2051265600, 2051265900]])
  })

  it('keeps a distinct 60-second pickup service for each shipment at the same restaurant', async () => {
    let requestBody: BodyInit | null | undefined
    vi.stubGlobal('fetch', async (_url: string | URL, options?: RequestInit) => {
      requestBody = options?.body
      return successfulVroomResponse()
    })
    const firstPickup = new Date('2035-01-01T12:00:00.000Z')
    const secondPickup = new Date('2035-01-01T12:01:00.000Z')

    await new VroomDispatchPlanner('http://vroom.test').checkFeasibility({
      ...input([shipment('existing', firstPickup)]),
      candidateShipment: shipment('candidate', secondPickup)
    })

    const body = JSON.parse(String(requestBody)) as {
      shipments: { amount: number[]; pickup: { location: number[]; service: number } }[]
    }
    expect(body.shipments).toHaveLength(2)
    expect(body.shipments.map(({ pickup }) => pickup.location)).toEqual([[5.2255, 46.2058], [5.2255, 46.2058]])
    expect(body.shipments.map(({ pickup }) => pickup.service)).toEqual([60, 60])
    expect(body.shipments.map(({ amount }) => amount)).toEqual([[1], [1]])
  })

  it('models an already collected parcel as a delivery-only job loaded at vehicle start', async () => {
    let requestBody: BodyInit | null | undefined
    vi.stubGlobal('fetch', async (_url: string | URL, options?: RequestInit) => {
      requestBody = options?.body
      return successfulVroomResponse()
    })
    const deliveryAt = new Date('2035-01-01T12:10:00.000Z')

    await new VroomDispatchPlanner('http://vroom.test').checkFeasibility(input([], [
      deliveryJob('collected', customer, deliveryAt)
    ]))

    const body = JSON.parse(String(requestBody)) as {
      jobs: { id: number; location: number[]; service: number; delivery: number[]; time_windows: number[][]; pickup?: unknown }[]
    }
    expect(body.jobs).toEqual([{
      id: 1,
      location: [5.23, 46.21],
      service: 60,
      delivery: [1],
      time_windows: [[2051266200, 2051266800]]
    }])
    expect(body.jobs[0]?.pickup).toBeUndefined()
  })
})

const vroomUrl = process.env.VROOM_INTEGRATION_URL
const describeVroom = vroomUrl === undefined ? describe.skip : describe

describeVroom('VroomDispatchPlanner capacity integration', () => {
  it('rejects a route requiring three simultaneous parcels', async () => {
    const planner = new VroomDispatchPlanner(vroomUrl as string)
    const pickupAt = new Date('2035-01-01T12:00:00.000Z')
    const shipments = [
      shipment('one', pickupAt, 900),
      shipment('two', new Date(pickupAt.getTime() + 60_000), 840)
    ]

    await expect(planner.checkFeasibility({
      ...input(shipments),
      candidateShipment: shipment('three', new Date(pickupAt.getTime() + 120_000), 780)
    })).resolves.toEqual({ feasible: false })
  })

  it('accepts more than two planned shipments when deliveries free capacity before the next pickup', async () => {
    const planner = new VroomDispatchPlanner(vroomUrl as string)
    const pickupAt = new Date('2035-01-01T12:00:00.000Z')
    const shipments = [
      shipment('one', pickupAt, 180),
      shipment('two', new Date(pickupAt.getTime() + 60_000), 180)
    ]

    await expect(planner.checkFeasibility({
      ...input(shipments),
      candidateShipment: shipment('three', new Date(pickupAt.getTime() + 1_100_000), 180)
    })).resolves.toMatchObject({ feasible: true })
  })

  it('accounts for a collected parcel as initial load while allowing a later pickup after its delivery', async () => {
    const planner = new VroomDispatchPlanner(vroomUrl as string)
    const pickupAt = new Date('2035-01-01T12:00:00.000Z')

    await expect(planner.checkFeasibility({
      ...input([], [deliveryJob('collected', customer, new Date(pickupAt.getTime() + 180_000))]),
      driver: { id: 'driver-1', location: restaurant },
      candidateShipment: shipment('candidate', new Date(pickupAt.getTime() + 600_000), 180)
    })).resolves.toMatchObject({ feasible: true })
  })

  it('accepts a new pickup after two collected parcels have both been delivered', async () => {
    const planner = new VroomDispatchPlanner(vroomUrl as string)
    const pickupAt = new Date('2035-01-01T12:00:00.000Z')

    await expect(planner.checkFeasibility({
      ...input([], [
        deliveryJob('collected-one', customer, new Date(pickupAt.getTime() + 180_000)),
        deliveryJob('collected-two', customer, new Date(pickupAt.getTime() + 300_000))
      ]),
      driver: { id: 'driver-1', location: restaurant },
      candidateShipment: shipment('candidate', new Date(pickupAt.getTime() + 900_000), 180)
    })).resolves.toMatchObject({ feasible: true })
  })

  it('rejects a pickup before either of two collected parcels can be delivered', async () => {
    const planner = new VroomDispatchPlanner(vroomUrl as string)
    const pickupAt = new Date('2035-01-01T12:00:00.000Z')

    await expect(planner.checkFeasibility({
      ...input([], [
        deliveryJob('collected-one', customer, new Date(pickupAt.getTime() + 600_000)),
        deliveryJob('collected-two', customer, new Date(pickupAt.getTime() + 660_000))
      ]),
      driver: { id: 'driver-1', location: restaurant },
      candidateShipment: shipment('candidate', pickupAt, 180)
    })).resolves.toEqual({ feasible: false })
  })

  it('keeps a returning parcel loaded until its restaurant return', async () => {
    const planner = new VroomDispatchPlanner(vroomUrl as string)
    const pickupAt = new Date('2035-01-01T12:00:00.000Z')

    await expect(planner.checkFeasibility({
      ...input([], [
        deliveryJob('collected', customer, new Date(pickupAt.getTime() + 600_000)),
        deliveryJob('returning', restaurant, new Date(pickupAt.getTime() + 660_000))
      ]),
      driver: { id: 'driver-1', location: restaurant },
      candidateShipment: shipment('candidate', pickupAt, 180)
    })).resolves.toEqual({ feasible: false })
  })
})
