import { randomUUID } from 'node:crypto'
import { createServer, type Server as HttpServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { io as createClient, type Socket } from 'socket.io-client'
import { processOutboxBatch } from '../../src/platform/outbox-relay.js'
import { pool } from '../../src/platform/db.js'
import {
  createSocketEventEmitter,
  createSocketServer,
  type DispatchStarter,
  type RealtimeSocketServer
} from '../../src/realtime/socket-handler.js'

const zoneId = '11111111-1111-1111-1111-111111111111'

type RealtimeServer = {
  httpServer: HttpServer
  io: RealtimeSocketServer
  url: string
}

type OutboxRow = {
  id: string
  published_at: Date | null
  attempts: number
  last_error: string | null
}

let realtime: RealtimeServer | undefined
const clients: Socket[] = []

function dispatchStarter(onStart: (orderId: string) => void = () => undefined): DispatchStarter {
  return {
    startDispatch: async (orderId) => {
      onStart(orderId)
    }
  }
}

async function startRealtimeServer(): Promise<RealtimeServer> {
  const httpServer = createServer()
  const io = createSocketServer(httpServer, {
    verifyToken: async (token) =>
      token.startsWith('merchant-')
        ? { id: token.slice('merchant-'.length), role: 'merchant' }
        : { id: token, role: 'driver' },
    findDriverById: async (id) => ({ id, name: 'Test driver', phone: null, zoneId, isAvailable: false }),
    isAvailable: async () => true,
    setUnavailable: async () => undefined
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject)
      resolve()
    })
  })

  const address = httpServer.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Realtime test server did not bind to a TCP port')
  }

  return { httpServer, io, url: `http://127.0.0.1:${address.port}` }
}

async function connectClient(url: string, token = '33333333-3333-3333-3333-333333333333'): Promise<Socket> {
  const socket = createClient(url, {
    transports: ['websocket'],
    auth: { token }
  })

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('connect_error', reject)
  })
  clients.push(socket)
  return socket
}

async function closeRealtime(): Promise<void> {
  for (const client of clients.splice(0)) client.disconnect()

  if (realtime !== undefined) {
    await new Promise<void>((resolve, reject) => {
      realtime?.io.close((error) => {
        if (error !== undefined) {
          reject(error)
          return
        }
        resolve()
      })
    })
    realtime = undefined
  }
}

async function insertOutboxEvent(
  payload: Record<string, unknown>,
  eventType = 'order.created.v1',
  published = false
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into outbox_event (
       event_type, event_version, aggregate_type, aggregate_id, aggregate_version,
       payload, correlation_id, created_at, published_at
     ) values ($1, 1, 'order', $2, 1, $3, $4, now() - interval '100 days', $5)
     returning id`,
    [eventType, randomUUID(), payload, randomUUID(), published ? new Date() : null]
  )
  const id = result.rows[0]?.id
  if (id === undefined) {
    throw new Error('Outbox event insert did not return an id')
  }
  return id
}

async function outboxRow(id: string): Promise<OutboxRow> {
  const result = await pool.query<OutboxRow>(
    'select id, published_at, attempts, last_error from outbox_event where id = $1',
    [id]
  )
  const row = result.rows[0]
  if (row === undefined) {
    throw new Error(`Outbox event ${id} was not found`)
  }
  return row
}

function waitForSocketEvent(socket: Socket, eventName: string, orderId: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(eventName, onEvent)
      reject(new Error(`Timed out waiting for ${eventName}`))
    }, 1_000)

    const onEvent = (payload: Record<string, unknown>) => {
      if (payload.orderId !== orderId) {
        return
      }
      clearTimeout(timeout)
      socket.off(eventName, onEvent)
      resolve(payload)
    }

    socket.on(eventName, onEvent)
  })
}

function expectNoSocketEvent(socket: Socket, eventName: string, orderId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = (payload: Record<string, unknown>) => {
      if (payload.orderId === orderId) {
        clearTimeout(timeout)
        socket.off(eventName, onEvent)
        reject(new Error(`Unexpected ${eventName} event`))
      }
    }
    const timeout = setTimeout(() => {
      socket.off(eventName, onEvent)
      resolve()
    }, 150)
    socket.on(eventName, onEvent)
  })
}

afterEach(async () => {
  await closeRealtime()
})

describe('outbox relay', () => {
  it('does not emit an event that was already published', async () => {
    realtime = await startRealtimeServer()
    const payload = { orderId: randomUUID(), zoneId, merchantId: randomUUID() }
    const eventId = await insertOutboxEvent(payload, 'order.created.v1', true)
    const started: string[] = []

    await processOutboxBatch(pool, createSocketEventEmitter(realtime.io, dispatchStarter((orderId) => started.push(orderId))))
    await new Promise<void>((resolve) => setTimeout(resolve, 100))

    expect(started).toEqual([])
    expect((await outboxRow(eventId)).published_at).not.toBeNull()
  })

  it('retries an event after an emission failure', async () => {
    const payload = { orderId: randomUUID(), zoneId, merchantId: randomUUID() }
    const eventId = await insertOutboxEvent(payload)

    await processOutboxBatch(pool, ({ payload: emittedPayload }) => {
      if (emittedPayload.orderId === payload.orderId) {
        throw new Error('temporary Socket.io failure')
      }
    })

    expect(await outboxRow(eventId)).toMatchObject({
      published_at: null,
      attempts: 1,
      last_error: 'temporary Socket.io failure'
    })

    const retried: string[] = []
    await processOutboxBatch(pool, ({ payload: emittedPayload }) => {
      if (emittedPayload.orderId === payload.orderId && typeof emittedPayload.orderId === 'string') {
        retried.push(emittedPayload.orderId)
      }
    })

    expect(retried).toEqual([payload.orderId])
    expect((await outboxRow(eventId)).published_at).not.toBeNull()
  })

  it('processes concurrent batches without emitting an event twice', async () => {
    const payloads = Array.from({ length: 12 }, () => ({
      orderId: randomUUID(),
      zoneId,
      merchantId: randomUUID()
    }))
    const eventIds = await Promise.all(payloads.map((payload) => insertOutboxEvent(payload)))
    const emissions = new Map<string, number>()

    const emit = async ({ payload }: { payload: Record<string, unknown> }): Promise<void> => {
      if (typeof payload.orderId !== 'string' || !payloads.some(({ orderId }) => orderId === payload.orderId)) {
        return
      }
      emissions.set(payload.orderId, (emissions.get(payload.orderId) ?? 0) + 1)
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
    }

    await Promise.all([processOutboxBatch(pool, emit), processOutboxBatch(pool, emit)])

    expect([...emissions.values()]).toHaveLength(payloads.length)
    expect([...emissions.values()]).toEqual(Array.from({ length: payloads.length }, () => 1))
    const rows = await Promise.all(eventIds.map(outboxRow))
    expect(rows.every((row) => row.published_at !== null)).toBe(true)
  })

  it('starts dispatch for a newly created order instead of broadcasting to the marketplace', async () => {
    realtime = await startRealtimeServer()
    const payload = { orderId: randomUUID(), zoneId, merchantId: randomUUID() }
    const eventId = await insertOutboxEvent(payload)
    const started: string[] = []

    await processOutboxBatch(pool, createSocketEventEmitter(realtime.io, dispatchStarter((orderId) => started.push(orderId))))

    expect(started).toEqual([payload.orderId])
    expect((await outboxRow(eventId)).published_at).not.toBeNull()
  })

  it('notifies only the offered driver of a dispatch offer', async () => {
    realtime = await startRealtimeServer()
    const offeredDriverId = '33333333-3333-3333-3333-333333333333'
    const otherDriverId = '44444444-4444-4444-4444-444444444444'
    const offeredClient = await connectClient(realtime.url, offeredDriverId)
    const otherClient = await connectClient(realtime.url, otherDriverId)
    const payload = {
      offerId: randomUUID(),
      orderId: randomUUID(),
      driverId: offeredDriverId,
      round: 1,
      radiusKm: 1,
      expiresAt: new Date().toISOString()
    }
    const eventId = await insertOutboxEvent(payload, 'dispatch.offer_created.v1')
    const received = waitForSocketEvent(offeredClient, 'dispatch_offer_created', payload.orderId)
    const notReceived = expectNoSocketEvent(otherClient, 'dispatch_offer_created', payload.orderId)

    await processOutboxBatch(pool, createSocketEventEmitter(realtime.io, dispatchStarter()))

    await expect(received).resolves.toEqual(payload)
    await expect(notReceived).resolves.toBeUndefined()
    expect((await outboxRow(eventId)).published_at).not.toBeNull()
  })

  it('notifies the merchant room when dispatch fails after the last round', async () => {
    realtime = await startRealtimeServer()
    const merchantId = randomUUID()
    const merchantClient = await connectClient(realtime.url, `merchant-${merchantId}`)
    const payload = { orderId: randomUUID(), merchantId }
    const eventId = await insertOutboxEvent(payload, 'order.dispatch_failed.v1')
    const received = waitForSocketEvent(merchantClient, 'dispatch_failed', payload.orderId)

    await processOutboxBatch(pool, createSocketEventEmitter(realtime.io, dispatchStarter()))

    await expect(received).resolves.toEqual(payload)
    expect((await outboxRow(eventId)).published_at).not.toBeNull()
  })

  it('emits order_taken to every socket in the zone', async () => {
    realtime = await startRealtimeServer()
    const firstClient = await connectClient(realtime.url, '33333333-3333-3333-3333-333333333333')
    const secondClient = await connectClient(realtime.url, '44444444-4444-4444-4444-444444444444')
    const payload = { orderId: randomUUID(), zoneId, merchantId: randomUUID() }
    const eventId = await insertOutboxEvent(payload, 'order.assigned.v1')
    const firstReceived = waitForSocketEvent(firstClient, 'order_taken', payload.orderId)
    const secondReceived = waitForSocketEvent(secondClient, 'order_taken', payload.orderId)

    await processOutboxBatch(pool, createSocketEventEmitter(realtime.io, dispatchStarter()))

    await expect(firstReceived).resolves.toEqual(payload)
    await expect(secondReceived).resolves.toEqual(payload)
    expect((await outboxRow(eventId)).published_at).not.toBeNull()
  })
})
