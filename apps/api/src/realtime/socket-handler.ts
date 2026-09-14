import type { Server as HttpServer } from 'node:http'
import { Server, type Socket } from 'socket.io'
import type { AuthenticatedUser } from '../modules/auth/public.js'
import type { Driver } from '../modules/drivers/public.js'
import type { EligibilityEngine } from '../modules/marketplace/public.js'
import type { OutboxEmit } from '../platform/outbox-relay.js'

function zoneRoom(zoneId: string): string {
  return `zone_${zoneId}`
}

export type RealtimeDependencies = {
  verifyToken(token: string): Promise<AuthenticatedUser>
  findDriverById(driverId: string): Promise<Driver | null>
  isAvailable(driverId: string): Promise<boolean>
}

export type RealtimeSocketServer = Server & {
  syncDriverPresence(driverId: string, available: boolean): Promise<void>
  getConnectedDriverIds(zoneId: string): Promise<readonly string[]>
  removeDriverFromZone(driverId: string, zoneId: string): Promise<void>
}

/**
 * The registry is intentionally process-local: Phase 1 runs one API instance,
 * so a Valkey Pub/Sub presence fanout would add needless distributed state.
 */
export function createSocketServer(httpServer: HttpServer, dependencies: RealtimeDependencies): RealtimeSocketServer {
  const io = new Server(httpServer, { transports: ['websocket'] })
  const driverSockets = new Map<string, Set<Socket>>()

  async function syncDriverPresence(driverId: string, available: boolean): Promise<void> {
    const sockets = driverSockets.get(driverId)
    if (sockets === undefined) return
    await Promise.all([...sockets].map(async (socket) => {
      const zoneId = socket.data.zoneId as string | undefined
      if (zoneId === undefined) return
      if (available) await socket.join(zoneRoom(zoneId))
      else await socket.leave(zoneRoom(zoneId))
    }))
  }

  async function getConnectedDriverIds(zoneId: string): Promise<readonly string[]> {
    const sockets = await io.in(zoneRoom(zoneId)).fetchSockets()
    return [...new Set(sockets.flatMap((socket) => {
      const driverId = socket.data.driverId
      return typeof driverId === 'string' ? [driverId] : []
    }))]
  }

  async function removeDriverFromZone(driverId: string, zoneId: string): Promise<void> {
    const sockets = driverSockets.get(driverId)
    if (sockets === undefined) return
    await Promise.all([...sockets].map(async (socket) => socket.leave(zoneRoom(zoneId))))
  }

  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token
    if (typeof token !== 'string') return next(new Error('Unauthorized'))
    try {
      const user = await dependencies.verifyToken(token)
      if (user.role !== 'driver') return next(new Error('Forbidden'))
      const driver = await dependencies.findDriverById(user.id)
      if (driver === null) return next(new Error('Driver profile was not found'))
      socket.data.driverId = driver.id
      socket.data.zoneId = driver.zoneId
      next()
    } catch {
      next(new Error('Unauthorized'))
    }
  })

  io.on('connection', (socket) => {
    const driverId = socket.data.driverId as string
    const sockets = driverSockets.get(driverId) ?? new Set<Socket>()
    sockets.add(socket)
    driverSockets.set(driverId, sockets)

    void dependencies.isAvailable(driverId).then(async (available) => {
      if (available && socket.connected) await syncDriverPresence(driverId, true)
    })

    socket.on('disconnect', () => {
      const current = driverSockets.get(driverId)
      current?.delete(socket)
      if (current?.size === 0) driverSockets.delete(driverId)
    })
  })

  return Object.assign(io, { syncDriverPresence, getConnectedDriverIds, removeDriverFromZone })
}

export function createSocketEventEmitter(realtime: RealtimeSocketServer, eligibilityEngine: EligibilityEngine): OutboxEmit {
  return async ({ eventType, payload }) => {
    const zoneId = payload.zoneId
    if (typeof zoneId !== 'string') return

    if (eventType === 'order.created.v1') {
      const orderId = payload.orderId
      if (typeof orderId !== 'string') return
      const eligibleDriverIds = new Set(await eligibilityEngine.getEligibleDrivers({ orderId, zoneId }))
      const sockets = await realtime.in(zoneRoom(zoneId)).fetchSockets()
      for (const socket of sockets) {
        const driverId = socket.data.driverId
        if (typeof driverId === 'string' && eligibleDriverIds.has(driverId)) socket.emit('new_order', payload)
      }
      return
    }
    if (eventType === 'order.assigned.v1') {
      realtime.to(zoneRoom(zoneId)).emit('order_taken', payload)
      return
    }
    realtime.to(zoneRoom(zoneId)).emit('order_updated', payload)
  }
}
