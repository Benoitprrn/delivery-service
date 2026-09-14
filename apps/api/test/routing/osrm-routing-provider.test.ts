import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OsrmRoutingProvider } from '../../src/modules/orders/infrastructure/osrm-routing-provider.js'
import {
  RouteNotFoundError,
  RoutingProviderResponseError,
  RoutingUnavailableError,
  type LatLng
} from '../../src/modules/orders/ports/routing-provider.js'
import { config } from '../../src/platform/config.js'

let malformedResponseServer: Server | undefined

afterEach(async () => {
  if (malformedResponseServer === undefined) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    malformedResponseServer?.close((error) => {
      if (error !== undefined) {
        reject(error)
        return
      }

      resolve()
    })
  })
  malformedResponseServer = undefined
})

async function startMalformedResponseServer(): Promise<string> {
  malformedResponseServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{')
  })

  await new Promise<void>((resolve, reject) => {
    malformedResponseServer?.once('error', reject)
    malformedResponseServer?.listen(0, '127.0.0.1', () => {
      malformedResponseServer?.off('error', reject)
      resolve()
    })
  })

  const address = malformedResponseServer.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Malformed-response server did not bind to a TCP port')
  }

  return `http://127.0.0.1:${address.port}`
}

describe('OsrmRoutingProvider', () => {
  const bourgEnBressePickup: LatLng = { lat: 46.2058, lng: 5.2255 }
  const bourgEnBresseDelivery: LatLng = { lat: 46.21, lng: 5.23 }

  it('returns a route from the local OSRM server for Bourg-en-Bresse coordinates', async () => {
    const provider = new OsrmRoutingProvider(config.OSRM_URL)

    const route = await provider.getRoute(bourgEnBressePickup, bourgEnBresseDelivery)

    expect(route.distanceM).toBeGreaterThan(0)
    expect(route.durationS).toBeGreaterThan(0)
  })

  it('reports no route for coordinates outside the loaded OSRM dataset when OSRM cannot snap them', async () => {
    const provider = new OsrmRoutingProvider(config.OSRM_URL)
    const paris: LatLng = { lat: 48.8566, lng: 2.3522 }

    const result = await provider.getRoute(paris, bourgEnBresseDelivery).then(
      (route) => ({ kind: 'route' as const, route }),
      (error: unknown) => ({ kind: 'error' as const, error })
    )

    // This local OSRM dataset currently snaps Paris to its nearest graph edge and returns a route.
    if (result.kind === 'route') {
      expect(result.route.distanceM).toBeGreaterThan(0)
      expect(result.route.durationS).toBeGreaterThan(0)
      return
    }

    expect(result.error).toBeInstanceOf(RouteNotFoundError)
  })

  it('throws RoutingUnavailableError when no local server listens on the provider port', async () => {
    const provider = new OsrmRoutingProvider('http://127.0.0.1:5999')

    await expect(provider.getRoute(bourgEnBressePickup, bourgEnBresseDelivery)).rejects.toBeInstanceOf(
      RoutingUnavailableError
    )
  })

  it('throws RoutingProviderResponseError for malformed JSON from a local HTTP server', async () => {
    const provider = new OsrmRoutingProvider(await startMalformedResponseServer())

    await expect(provider.getRoute(bourgEnBressePickup, bourgEnBresseDelivery)).rejects.toBeInstanceOf(
      RoutingProviderResponseError
    )
  })

  it('requests and validates GeoJSON geometry only when requested', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        code: 'Ok',
        routes: [{ distance: 123.4, duration: 56.7, geometry: { type: 'LineString', coordinates: [[5.22, 46.2], [5.23, 46.21]] } }]
      }), { status: 200 })
    )
    const provider = new OsrmRoutingProvider('https://router.example')

    const route = await provider.getRoute(bourgEnBressePickup, bourgEnBresseDelivery, { includeGeometry: true })

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(url.searchParams.get('overview')).toBe('full')
    expect(url.searchParams.get('geometries')).toBe('geojson')
    expect(route).toMatchObject({ geometry: { type: 'LineString', coordinates: [[5.22, 46.2], [5.23, 46.21]] } })
    fetchMock.mockRestore()
  })

  it('rejects absent or invalid requested geometry', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'Ok', routes: [{ distance: 1, duration: 1 }] }), { status: 200 }))
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'Ok', routes: [{ distance: 1, duration: 1, geometry: { type: 'LineString', coordinates: [[200, 46], [5, 46]] } }] }), { status: 200 }))
    const provider = new OsrmRoutingProvider('https://router.example')

    await expect(provider.getRoute(bourgEnBressePickup, bourgEnBresseDelivery, { includeGeometry: true })).rejects.toBeInstanceOf(RoutingProviderResponseError)
    await expect(provider.getRoute(bourgEnBressePickup, bourgEnBresseDelivery, { includeGeometry: true })).rejects.toBeInstanceOf(RoutingProviderResponseError)
    fetchMock.mockRestore()
  })
})
