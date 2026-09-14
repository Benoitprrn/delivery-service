import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { OpenCageGeocodingProvider } from '../../src/modules/orders/infrastructure/opencage-geocoding-provider.js'
import {
  AddressNotFoundError,
  GeocodingProviderResponseError,
  GeocodingUnavailableError
} from '../../src/modules/orders/ports/geocoding-provider.js'
import { config } from '../../src/platform/config.js'

let responseServer: Server | undefined

afterEach(async () => {
  if (responseServer === undefined) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    responseServer?.close((error) => {
      if (error !== undefined) {
        reject(error)
        return
      }

      resolve()
    })
  })
  responseServer = undefined
})

async function startResponseServer(body: string): Promise<string> {
  responseServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(body)
  })

  await new Promise<void>((resolve, reject) => {
    responseServer?.once('error', reject)
    responseServer?.listen(0, '127.0.0.1', () => {
      responseServer?.off('error', reject)
      resolve()
    })
  })

  const address = responseServer.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Response server did not bind to a TCP port')
  }

  return `http://127.0.0.1:${address.port}`
}

describe('OpenCageGeocodingProvider', () => {
  const bourgEnBresseAddress = 'Place de la Grenette, 01000 Bourg-en-Bresse'

  it('geocodes a Bourg-en-Bresse address with the real OpenCage API', async () => {
    const provider = new OpenCageGeocodingProvider(config.OPENCAGE_API_KEY)

    const location = await provider.geocode(bourgEnBresseAddress)

    expect(location.lat).toBeGreaterThan(46.1)
    expect(location.lat).toBeLessThan(46.3)
    expect(location.lng).toBeGreaterThan(5.1)
    expect(location.lng).toBeLessThan(5.3)
  })

  it('throws GeocodingProviderResponseError for malformed JSON from a local HTTP server', async () => {
    const provider = new OpenCageGeocodingProvider(config.OPENCAGE_API_KEY, await startResponseServer('{'))

    await expect(provider.geocode(bourgEnBresseAddress)).rejects.toBeInstanceOf(GeocodingProviderResponseError)
  })

  it('throws AddressNotFoundError when a local HTTP server returns no results', async () => {
    const provider = new OpenCageGeocodingProvider(config.OPENCAGE_API_KEY, await startResponseServer('{"results":[]}'))

    await expect(provider.geocode(bourgEnBresseAddress)).rejects.toBeInstanceOf(AddressNotFoundError)
  })

  it('throws GeocodingUnavailableError when no local server listens on the provider port', async () => {
    const provider = new OpenCageGeocodingProvider(config.OPENCAGE_API_KEY, 'http://127.0.0.1:5999')

    await expect(provider.geocode(bourgEnBresseAddress)).rejects.toBeInstanceOf(GeocodingUnavailableError)
  })
})
