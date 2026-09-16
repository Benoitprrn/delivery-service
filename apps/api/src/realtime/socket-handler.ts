import type { Server as HttpServer } from 'node:http'
import { Server, type Socket } from 'socket.io'
import type { AuthenticatedUser } from '../modules/auth/public.js'
import type { Driver } from '../modules/drivers/public.js'
import { logger } from '../platform/logger.js'
import type { OutboxEmit } from '../platform/outbox-relay.js'

function zoneRoom(zoneId: string): string {
  return `zone_${zoneId}`
}

function merchantRoom(merchantId: string): string {
  return `merchant_${merchantId}`
}

export type RealtimeDependencies = {
  verifyToken(token: string): Promise<AuthenticatedUser>
  findDriverById(driverId: string): Promise<Driver | null>
  isAvailable(driverId: string): Promise<boolean>
  setUnavailable(driverId: string): Promise<void>
}

export type RealtimeSocketServer = Server & {
  syncDriverPresence(driverId: string, available: boolean): Promise<void>
  getConnectedDriverIds(zoneId: string): Promise<readonly string[]>
  removeDriverFromZone(driverId: string, zoneId: string): Promise<void>
  emitTrackingPosition(trackingToken: string, position: { lat: number; lng: number }): void
  emitToDriver(driverId: string, event: string, payload: Record<string, unknown>): void
}

function trackingRoom(trackingToken: string): string {
  return `tracking:${trackingToken}`
}

/**
 * The registry is intentionally process-local: Phase 1 runs one API instance,
 * so a Valkey Pub/Sub presence fanout would add needless distributed state.
 */
export function createSocketServer(httpServer: HttpServer, dependencies: RealtimeDependencies): RealtimeSocketServer {
  const io = new Server(httpServer, { transports: ['websocket'] })
  // This namespace deliberately has no JWT middleware. Its opaque tracking
  // token is the capability and it is isolated from the authenticated driver IO.
  const tracking = io.of('/tracking')
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

  function emitTrackingPosition(trackingToken: string, position: { lat: number; lng: number }): void {
    tracking.to(trackingRoom(trackingToken)).emit('driver_position_updated', {
      lat: position.lat,
      lng: position.lng,
      tracking_token: trackingToken
    })
  }

  tracking.on('connection', (socket) => {
    const token = socket.handshake.auth.tracking_token
    if (typeof token !== 'string' || token.length === 0) {
      socket.disconnect(true)
      return
    }
    void socket.join(trackingRoom(token))
  })

  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token
    if (typeof token !== 'string') return next(new Error('Unauthorized'))
    try {
      const user = await dependencies.verifyToken(token)
      if (user.role === 'merchant') {
        socket.data.merchantId = user.id
        return next()
      }
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
    const merchantId = socket.data.merchantId as string | undefined
    if (merchantId !== undefined) {
      void socket.join(merchantRoom(merchantId))
      return
    }

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
      if (current?.size === 0) {
        driverSockets.delete(driverId)
        // The final driver socket disappearing is a safety net alongside the
        // heartbeat TTL. This deliberately uses availability only: location
        // history remains available until an explicit sign-out.
        void dependencies.setUnavailable(driverId).catch((error: unknown) => {
          logger.error({ err: error, driverId }, 'Could not mark driver unavailable after final socket disconnect')
        })
      }
    })
  })

  function emitToDriver(driverId: string, event: string, payload: Record<string, unknown>): void {
    const sockets = driverSockets.get(driverId)
    if (sockets === undefined) return
    for (const socket of sockets) socket.emit(event, payload)
  }

  return Object.assign(io, { syncDriverPresence, getConnectedDriverIds, removeDriverFromZone, emitTrackingPosition, emitToDriver })
}

export type DispatchStarter = { startDispatch(orderId: string): Promise<void> }
export type DispatchOfferPushSender = {
  sendDispatchOfferPush(command: { driverId: string; offerId: string; orderId: string }): Promise<void>
}

export function createSocketEventEmitter(
  realtime: RealtimeSocketServer,
  dispatch: DispatchStarter,
  notifications: DispatchOfferPushSender = { sendDispatchOfferPush: async () => undefined }
): OutboxEmit {
  return async ({ eventType, payload }) => {
    if (eventType === 'order.created.v1') {
      const orderId = payload.orderId
      if (typeof orderId !== 'string') return
      // The sequential VROOM dispatcher replaces the marketplace broadcast:
      // notifying one driver at a time happens on dispatch.offer_created.v1,
      // not here.
      await dispatch.startDispatch(orderId)
      return
    }
    if (eventType === 'dispatch.offer_created.v1') {
      const driverId = payload.driverId
      const offerId = payload.offerId
      const orderId = payload.orderId
      if (typeof driverId !== 'string' || typeof offerId !== 'string' || typeof orderId !== 'string') return
      logger.info({ orderId: payload.orderId, driverId, round: payload.round }, 'Notifying driver of a dispatch offer')
      realtime.emitToDriver(driverId, 'dispatch_offer_created', payload)
      void notifications.sendDispatchOfferPush({ driverId, offerId, orderId }).catch((error: unknown) => {
        logger.error({ err: error, driverId, offerId, orderId }, 'Could not send dispatch offer push notification')
      })
      return
    }
    if (eventType === 'order.dispatch_failed.v1') {
      const merchantId = payload.merchantId
      if (typeof merchantId !== 'string') return
      realtime.to(merchantRoom(merchantId)).emit('dispatch_failed', payload)
      return
    }

    const zoneId = payload.zoneId
    if (typeof zoneId !== 'string') return
    if (eventType === 'order.assigned.v1') {
      realtime.to(zoneRoom(zoneId)).emit('order_taken', payload)
      return
    }
    realtime.to(zoneRoom(zoneId)).emit('order_updated', payload)
  }
}
