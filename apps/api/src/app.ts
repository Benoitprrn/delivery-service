import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { createMerchantsModule } from './modules/merchants/public.js'
import { registerMerchantHttpRoutes } from './modules/merchants/transport/http/routes.js'
import { createAuthModule } from './modules/auth/public.js'
import { createDriversModule, registerDriverHttpRoutes } from './modules/drivers/public.js'
import { createOrdersModule } from './modules/orders/public.js'
import { registerOrderHttpRoutes } from './modules/orders/transport/http/routes.js'
import { createMarketplaceModule } from './modules/marketplace/public.js'
import { createZonesModule } from './modules/zones/public.js'
import { config } from './platform/config.js'
import { createLoggerOptions } from './platform/logger.js'
import { registerCorrelationId } from './platform/correlation-id.js'
import { pool } from './platform/db.js'
import { valkey } from './platform/valkey.js'
import { startOutboxRelay } from './platform/outbox-relay.js'
import { createSocketEventEmitter, createSocketServer } from './realtime/socket-handler.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function buildApp(): Promise<FastifyInstance> {
  // Fastify instancie son propre logger Pino à partir des options — passer une
  // instance pino déjà construite (loggerInstance) provoque un conflit de type
  // FastifyBaseLogger / pino.Logger sous exactOptionalPropertyTypes.
  const app = Fastify({ logger: createLoggerOptions() })
  // app.server est le serveur HTTP sous-jacent ; Socket.io peut donc y être
  // attaché avant listen(), y compris pour les serveurs de tests Fastify.
  registerCorrelationId(app)
  const auth = createAuthModule(config.SUPABASE_URL)
  auth.registerAuthentication(app)

  await app.register(cors, { origin: true })
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' })
  await app.register(fastifyStatic, {
    root: join(__dirname, '../../web/public'),
    prefix: '/'
  })

  const merchants = createMerchantsModule(pool)
  let syncDriverPresence: (driverId: string, available: boolean) => Promise<void> | void = () => undefined
  const drivers = createDriversModule(pool, valkey, (driverId, available) => syncDriverPresence(driverId, available))
  const realtime = createSocketServer(app.server, {
    verifyToken: auth.verifyToken,
    findDriverById: drivers.findDriverById,
    isAvailable: drivers.isAvailable
  })
  syncDriverPresence = realtime.syncDriverPresence
  const marketplace = createMarketplaceModule({
    zoneConnections: { getConnectedDriverIds: realtime.getConnectedDriverIds },
    availability: { isAvailable: drivers.isAvailable },
    zoneMembership: { removeDriverFromZone: realtime.removeDriverFromZone }
  })
  const orders = createOrdersModule(pool, config.OSRM_URL, config.OPENCAGE_API_KEY, {
    isAvailable: drivers.isAvailable
  })
  const stopOutboxRelay = startOutboxRelay(pool, createSocketEventEmitter(realtime, marketplace.eligibilityEngine))

  app.addHook('onClose', async () => {
    stopOutboxRelay()
    realtime.disconnectSockets(true)
    // valkey, comme pool, est un client partagé au niveau du module et réutilisé
    // par chaque buildApp() (tests inclus) — le fermer ici casserait tous les
    // autres appels en cours. Sa fermeture relève du process, pas de l'app.
  })
  const { findMerchantById } = merchants
  const { findDriverById } = drivers
  const { findZoneById } = createZonesModule(pool)
  await app.register(registerMerchantHttpRoutes, { merchants })
  await app.register(registerDriverHttpRoutes, { drivers })
  await app.register(registerOrderHttpRoutes, { orders, findMerchantById, findZoneById, findDriverById })

  app.get('/health', async () => ({ status: 'ok' }))

  return app
}
