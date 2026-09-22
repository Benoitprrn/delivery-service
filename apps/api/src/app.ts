import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { createMerchantsModule, createSireneProvider, isMerchantLegalInformationComplete, registerMerchantHttpRoutes, SupabaseMerchantLogoStorage } from './modules/merchants/public.js'
import { createAuthModule, registerAuthHttpRoutes } from './modules/auth/public.js'
import { createDriversModule, registerDriverHttpRoutes } from './modules/drivers/public.js'
import { createMerchantSettlementReadiness, createOrdersModule, registerOrderHttpRoutes, type DriverEligibility, type MerchantSettlementReadinessReader } from './modules/orders/public.js'
import { DecideDriverReversalUseCase, GetAdminOverviewUseCase, GetDriverSettlementsUseCase, GetMerchantSettlementDetailUseCase, GetMerchantSettlementsUseCase, OrdersCurrentWeekEstimator, PostgresSettlementReadRepository, registerSettlementReadRoutes, RequestDriverReversalUseCase, type SettlementDirectory, CloseSettlementPeriodUseCase, DriverPayoutAccountUseCases, PostgresDebitOpsRepository, PostgresDebitRetryRepository, PostgresReconciliationRepository, PostgresSettlementEventRepository, ProcessSettlementWebhooksUseCase, ReceiveSettlementWebhookUseCase, RequestDebitRetryUseCase, registerSettlementAdminRoutes, RunSettlementReconciliationUseCase, startIntervalWorker, StripeChargeIncidentReader, StripeReconciliationReader, PostgresDriverConnectRepository, ExecuteDriverReversalsUseCase, PostgresDriverPayoutRepository, PostgresDriverReversalRepository, PostgresPreNotificationRepository, PostgresSepaDebitRepository, ProviderDriverAccountLiveReader, RunDriverPayoutsUseCase, startDriverPayoutWorker, startDriverReversalWorker, StripeDriverReversalProvider, StripeDriverTransferProvider, PostgresSettlementCloseRepository, RunSepaDebitsUseCase, startSepaDebitWorker, StripeSepaDebitProvider, ResendEmailSender, SendPreNotificationsUseCase, startSettlementCloseWorker, startSettlementPreNotificationWorker, PostgresDriverPayoutReadinessReader, registerDriverPayoutRoutes, StripeDriverConnectProvider, UnavailableDriverConnectProvider, type DriverConnectProvider } from './modules/settlements/public.js'
import { createDispatchModule, registerDispatchHttpRoutes } from './modules/dispatch/public.js'
import { createNotificationsModule } from './modules/notifications/public.js'
import { createZonesModule } from './modules/zones/public.js'
import { createGeocodingModule } from './modules/geocoding/public.js'
import { config } from './platform/config.js'
import { createLoggerOptions } from './platform/logger.js'
import { registerCorrelationId } from './platform/correlation-id.js'
import { pool } from './platform/db.js'
import { valkey } from './platform/valkey.js'
import { startOutboxRelay } from './platform/outbox-relay.js'
import { pgBoss, startPgBoss, stopPgBoss } from './platform/pgboss.js'
import { createSocketEventEmitter, createSocketServer } from './realtime/socket-handler.js'
import multipart from '@fastify/multipart'
import rawBody from 'fastify-raw-body'
import { createPaymentsModule, type VerifiedPlatformEvent, createStripeConnectWebhookModule, createStripeProvider, reconcilerNotWired, registerPaymentHttpRoutes, registerStripeConnectWebhookRoute, startStripeConnectWebhookWorker, startStripePaymentsWorker } from './modules/payments/public.js'
import { CardPaymentsUseCases, createCashOnDeliveryReconciliation, type ConnectPaymentsProvider, DeliveryCompletionUseCases, PostgresCashOnDeliveryReconciliationRepository, startCashOnDeliveryReconciliationWorker, PostgresCashOnDeliveryPaymentRepository, PostgresMerchantConnectRepository, registerCardPaymentsHttpRoutes, registerCashOnDeliveryHttpRoutes, StripeConnectDirectProvider, UnavailableConnectPaymentsProvider } from './modules/cash-on-delivery/public.js'
import Stripe from 'stripe'

const __dirname = dirname(fileURLToPath(import.meta.url))

// `overrides` sert aux tests : injecter un provider Connect fake (aucun réseau Stripe) et, pour les tests HTTP qui créent des
// commandes sans données de règlement en base, une garde D-D de remplacement (jamais utilisée en production).
export async function buildApp(overrides: { connectProvider?: ConnectPaymentsProvider; merchantSettlementReadiness?: MerchantSettlementReadinessReader; driverEligibility?: DriverEligibility; driverConnectProvider?: DriverConnectProvider } = {}): Promise<FastifyInstance> {
  // Fastify instancie son propre logger Pino à partir des options — passer une
  // instance pino déjà construite (loggerInstance) provoque un conflit de type
  // FastifyBaseLogger / pino.Logger sous exactOptionalPropertyTypes.
  const app = Fastify({ logger: createLoggerOptions() })
  await startPgBoss()
  // app.server est le serveur HTTP sous-jacent ; Socket.io peut donc y être
  // attaché avant listen(), y compris pour les serveurs de tests Fastify.
  registerCorrelationId(app)
  const auth = createAuthModule(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY)
  auth.registerAuthentication(app)

  await app.register(cors, { origin: true })
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' })
  await app.register(multipart, { limits: { files: 1, fileSize: 2 * 1024 * 1024 } })
  await app.register(rawBody, { field: 'rawBody', global: false, encoding: 'utf8', runFirst: true })
  await app.register(fastifyStatic, {
    root: join(__dirname, '../../web/public'),
    prefix: '/'
  })

  const geocoding = createGeocodingModule(config.OPENCAGE_API_KEY)
  const zones = createZonesModule(pool)
  const sirene = createSireneProvider(config.INSEE_API_KEY)
  const merchants = createMerchantsModule(pool, new SupabaseMerchantLogoStorage(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY), auth.admin, geocoding, { findById: zones.findZoneById, findContainingPoint: zones.findContainingPoint }, sirene)
  let syncDriverPresence: (driverId: string, available: boolean) => Promise<void> | void = () => undefined
  let isDriverAvailable: (driverId: string) => Promise<boolean> = async () => false
  let incrementDriverCapacity: (driverId: string) => Promise<number> = async () => 0
  let decrementDriverCapacity: (driverId: string) => Promise<number> = async () => 0
  let cardPaymentsReady: (merchantId: string) => Promise<boolean> = async () => false
  // Journal des webhooks plateforme du règlement (R70) : liaison tardive, sans effet tant que le worker n'est pas activé.
  let settlementEventSink: (event: VerifiedPlatformEvent) => Promise<unknown> = async () => undefined
  // Gardes du règlement livreurs (ADR 0004) : liaison tardive, fermée par défaut tant que non câblée.
  let merchantSettlementReady: MerchantSettlementReadinessReader = { check: async () => ({ ready: false, reason: 'sepa_not_configured' }) }
  const driverPayoutReadiness = new PostgresDriverPayoutReadinessReader(pool)
  const orders = createOrdersModule(pool, config.OSRM_URL, geocoding.geocode, {
    isAvailable: (driverId) => isDriverAvailable(driverId)
  }, {
    increment: async (driverId) => { await incrementDriverCapacity(driverId) },
    decrement: async (driverId) => { await decrementDriverCapacity(driverId) }
  }, { isReady: (merchantId) => cardPaymentsReady(merchantId) }, {
    check: (merchantId) => merchantSettlementReady.check(merchantId)
  }, overrides.driverEligibility ?? { isEligible: (driverId) => driverPayoutReadiness.isReady(driverId) })
  let emitTrackingPosition: (trackingToken: string, position: { lat: number; lng: number }) => void = () => undefined
  const drivers = createDriversModule(pool, valkey, (driverId, available) => syncDriverPresence(driverId, available), {
    activeOrders: { findActiveTrackingTokensByDriverId: orders.findActiveTrackingTokensByDriverId },
    emitter: { emitTrackingPosition: (trackingToken, position) => emitTrackingPosition(trackingToken, position) }
  })
  isDriverAvailable = drivers.isAvailable
  incrementDriverCapacity = drivers.incrementCapacity
  decrementDriverCapacity = drivers.decrementCapacity
  const dispatch = createDispatchModule(pool, config.VROOM_URL, orders, drivers, pgBoss)
  const notifications = createNotificationsModule(drivers)
  await dispatch.registerWorkers()
  const realtime = createSocketServer(app.server, {
    verifyToken: auth.verifyToken,
    findDriverById: drivers.findDriverById,
    isAvailable: drivers.isAvailable,
    setUnavailable: async (driverId) => { await drivers.setAvailability(driverId, false) }
  })
  syncDriverPresence = realtime.syncDriverPresence
  emitTrackingPosition = realtime.emitTrackingPosition
  const stopOutboxRelay = startOutboxRelay(pool, createSocketEventEmitter(
    realtime,
    { startDispatch: dispatch.startDispatch },
    { sendDispatchOfferPush: notifications.sendDispatchOfferPush }
  ))

  app.addHook('onClose', async () => {
    stopOutboxRelay()
    await stopPgBoss()
    realtime.disconnectSockets(true)
    // valkey, comme pool, est un client partagé au niveau du module et réutilisé
    // par chaque buildApp() (tests inclus) — le fermer ici casserait tous les
    // autres appels en cours. Sa fermeture relève du process, pas de l'app.
  })
  const { findMerchantById } = merchants
  const { findDriverById } = drivers
  const { findZoneById } = zones
  await app.register(registerMerchantHttpRoutes, { merchants })
  const payments = createPaymentsModule(pool, createStripeProvider(config.STRIPE_PAYMENTS_ENABLED, config.STRIPE_SECRET_KEY, config.STRIPE_WEBHOOK_SECRET, config.STRIPE_ACCOUNTS_V2_API_VERSION), merchants.findMerchantById, merchants.getLegalInformation, app.log, (event) => settlementEventSink(event))
  const connectProvider: ConnectPaymentsProvider = overrides.connectProvider ?? (config.STRIPE_PAYMENTS_ENABLED && config.STRIPE_SECRET_KEY !== undefined
    ? new StripeConnectDirectProvider(new Stripe(config.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 20_000 }), config.STRIPE_ACCOUNTS_V2_API_VERSION)
    : new UnavailableConnectPaymentsProvider())
  const cardPayments = new CardPaymentsUseCases(payments, connectProvider, new PostgresMerchantConnectRepository(pool), {
    returnUrl: `${config.WEB_APP_URL}/merchant/account`,
    refreshUrl: `${config.WEB_APP_URL}/merchant/account`
  }, { logger: app.log })
  cardPaymentsReady = (merchantId) => cardPayments.isReady(merchantId)
  merchantSettlementReady = overrides.merchantSettlementReadiness ?? createMerchantSettlementReadiness({
    hasActiveSepaMethod: payments.hasActiveSepaMethod,
    isLegalInformationComplete: async (merchantId) => {
      const legal = await merchants.getLegalInformation(merchantId)
      return legal !== null && isMerchantLegalInformationComplete(legal)
    }
  })
  // Compte de paiement Stripe du livreur (R30) : création explicite, onboarding, lien Dashboard, resynchronisation.
  const driverConnectRepository = new PostgresDriverConnectRepository(pool)
  const driverConnectProvider: DriverConnectProvider = overrides.driverConnectProvider ?? (config.STRIPE_PAYMENTS_ENABLED && config.STRIPE_SECRET_KEY !== undefined
    ? new StripeDriverConnectProvider(new Stripe(config.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 20_000 }), config.STRIPE_ACCOUNTS_V2_API_VERSION)
    : new UnavailableDriverConnectProvider())
  const driverPayoutAccount = new DriverPayoutAccountUseCases(driverConnectRepository, driverConnectProvider, {
    returnUrl: `${config.WEB_APP_URL}/driver/payout-account/return`,
    refreshUrl: `${config.WEB_APP_URL}/driver/payout-account/refresh`
  })
  await app.register(registerDriverPayoutRoutes, { payoutAccount: driverPayoutAccount, findDriverName: async (driverId) => (await drivers.findDriverById(driverId))?.name ?? null })
  const completion = new DeliveryCompletionUseCases(pool, orders, connectProvider, payments.getMerchantStripeAccountId, merchants.findMerchantById, merchants.getLegalInformation, config.TERMINAL_ALLOW_SIMULATED_READER)
  const codReconciliation = createCashOnDeliveryReconciliation({
    repository: new PostgresCashOnDeliveryReconciliationRepository(pool),
    provider: connectProvider,
    orders,
    logger: app.log
  })
  const stopCodReconciliationWorker = config.STRIPE_PAYMENTS_ENABLED
    ? startCashOnDeliveryReconciliationWorker(() => codReconciliation.reconcileCashOnDeliveryPayments(), app.log)
    : () => undefined
  app.addHook('onClose', () => { stopCodReconciliationWorker() })
  await app.register(registerPaymentHttpRoutes, { payments })
  const stopStripeWorker = config.STRIPE_PAYMENTS_ENABLED
    ? startStripePaymentsWorker({
      processWebhooks: payments.processWebhookBatch,
      reconcileDetachments: payments.reconcileDetachments
    }, app.log)
    : () => undefined
  app.addHook('onClose', () => { stopStripeWorker() })
  // Webhook Connect (Direct Charge COD) : endpoint, secret et worker distincts du SEPA.
  // TODO(T27) : remplacer `reconcilerNotWired` par `reconcilePaymentIntent` de cash-on-delivery/public.ts.
  const codPayments = new PostgresCashOnDeliveryPaymentRepository(pool)
  const connectWebhooks = createStripeConnectWebhookModule(pool, {
    paymentsEnabled: config.STRIPE_PAYMENTS_ENABLED,
    secretKey: config.STRIPE_SECRET_KEY,
    webhookSecret: config.STRIPE_CONNECT_WEBHOOK_SECRET,
    domain: {
      findPaymentAccountId: async (paymentIntentId) => (await codPayments.findByPaymentIntentId(paymentIntentId))?.stripeAccountId ?? null,
      reconcilePaymentIntent: reconcilerNotWired,
      refreshMerchantAccountStatus: async (merchantId) => { await cardPayments.getStatus(merchantId) },
      refreshDriverAccountStatus: async (driverId) => { await driverPayoutAccount.sync(driverId) },
      findDriverIdByAccountId: (accountId) => driverConnectRepository.findDriverIdByAccountId(accountId)
    }
  }, app.log)
  await app.register(registerStripeConnectWebhookRoute, { webhooks: connectWebhooks })
  const stopConnectWebhookWorker = connectWebhooks.enabled
    ? startStripeConnectWebhookWorker(connectWebhooks.processBatch, app.log)
    : () => undefined
  app.addHook('onClose', () => { stopConnectWebhookWorker() })
  // Clôture hebdomadaire du règlement (R40) : lundi 00:05 Europe/Paris ; inerte tant que go_live_at n'est pas posé.
  const stopSettlementCloseWorker = config.SETTLEMENT_CLOSE_WORKER_ENABLED
    ? startSettlementCloseWorker(new CloseSettlementPeriodUseCase(new PostgresSettlementCloseRepository(pool), orders), app.log)
    : () => undefined
  app.addHook('onClose', () => { stopSettlementCloseWorker() })
  // Pré-notification SEPA du lundi (R41) : e-mail Locadely via Resend, inerte tant que le flag est faux.
  const stopPreNotificationWorker = config.SETTLEMENT_PRE_NOTIFICATION_WORKER_ENABLED && config.RESEND_API_KEY !== undefined && config.RESEND_FROM_EMAIL !== undefined && config.SEPA_CREDITOR_ID !== undefined && config.SETTLEMENT_SUPPORT_EMAIL !== undefined
    ? startSettlementPreNotificationWorker(new SendPreNotificationsUseCase(
      new PostgresPreNotificationRepository(pool),
      {
        read: async (merchantId) => {
          const [email, mandate, legal, merchant] = await Promise.all([auth.admin.getUserEmail(merchantId), payments.findActiveSepaMandate(merchantId), merchants.getLegalInformation(merchantId), findMerchantById(merchantId)])
          return { email, legalName: legal?.legalName ?? merchant?.name ?? 'Madame, Monsieur', activeSepaMethod: mandate }
        }
      },
      new ResendEmailSender(config.RESEND_API_KEY, config.RESEND_FROM_EMAIL),
      { creditorId: config.SEPA_CREDITOR_ID, supportEmail: config.SETTLEMENT_SUPPORT_EMAIL },
      app.log
    ), app.log)
    : () => undefined
  app.addHook('onClose', () => { stopPreNotificationWorker() })
  // Prélèvement SEPA du mercredi (R50) et paiement des livreurs (R60) : inertes tant que leurs flags sont faux.
  const settlementStripe = config.STRIPE_PAYMENTS_ENABLED && config.STRIPE_SECRET_KEY !== undefined ? new Stripe(config.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 20_000 }) : null
  const stripeLivemode = config.STRIPE_SECRET_KEY?.startsWith('sk_live_') === true || config.STRIPE_SECRET_KEY?.startsWith('rk_live_') === true
  const sepaDebitProvider = settlementStripe === null ? null : new StripeSepaDebitProvider(settlementStripe, stripeLivemode)
  const stopSepaDebitWorker = config.SETTLEMENT_DEBIT_WORKER_ENABLED && sepaDebitProvider !== null
    ? startSepaDebitWorker(new RunSepaDebitsUseCase(new PostgresSepaDebitRepository(pool), { findActive: payments.findActiveSepaDebitSource }, sepaDebitProvider, app.log), app.log)
    : () => undefined
  app.addHook('onClose', () => { stopSepaDebitWorker() })
  const stopDriverPayoutWorker = config.SETTLEMENT_PAYOUT_WORKER_ENABLED && settlementStripe !== null && sepaDebitProvider !== null
    ? startDriverPayoutWorker(new RunDriverPayoutsUseCase(
      new PostgresDriverPayoutRepository(pool), sepaDebitProvider, new StripeDriverTransferProvider(settlementStripe, stripeLivemode), new ProviderDriverAccountLiveReader(driverConnectProvider), app.log
    ), app.log)
    : () => undefined
  app.addHook('onClose', () => { stopDriverPayoutWorker() })
  // Reversals de Transfers (R61) : n'exécute que des reversals approuvées par une seconde personne ; inerte tant que le flag est faux.
  const stopDriverReversalWorker = config.SETTLEMENT_REVERSAL_WORKER_ENABLED && settlementStripe !== null
    ? startDriverReversalWorker(new ExecuteDriverReversalsUseCase(new PostgresDriverReversalRepository(pool), new StripeDriverReversalProvider(settlementStripe, stripeLivemode), app.log), app.log)
    : () => undefined
  app.addHook('onClose', () => { stopDriverReversalWorker() })
  // Incidents / webhooks / réconciliation (R70) : le webhook plateforme n'est qu'un déclencheur (journal sans payload) ; l'état vient toujours d'une relecture Stripe.
  const reconciliation = settlementStripe === null ? null : new RunSettlementReconciliationUseCase(new PostgresReconciliationRepository(pool), new StripeReconciliationReader(settlementStripe), app.log)
  if (config.SETTLEMENT_WEBHOOK_WORKER_ENABLED && settlementStripe !== null && reconciliation !== null) {
    const receive = new ReceiveSettlementWebhookUseCase(new PostgresSettlementEventRepository(pool), app.log)
    settlementEventSink = (event) => receive.receive(event, new Date())
    const process = new ProcessSettlementWebhooksUseCase(new PostgresSettlementEventRepository(pool), new PostgresDebitOpsRepository(pool), new StripeChargeIncidentReader(settlementStripe), (id, now) => reconciliation.auditTransfer(id, now), app.log)
    const stopSettlementWebhookWorker = startIntervalWorker('Settlement webhook', () => process.processBatch({ now: new Date() }), app.log, 5_000)
    app.addHook('onClose', () => { stopSettlementWebhookWorker() })
  }
  if (config.SETTLEMENT_RECONCILIATION_WORKER_ENABLED && reconciliation !== null) {
    const repository = new PostgresReconciliationRepository(pool)
    // Un passage par jour, à partir de 03:00 Europe/Paris (relance au démarrage si le dernier passage a plus de 23 h).
    const stopReconciliationWorker = startIntervalWorker('Settlement reconciliation', async () => {
      const now = new Date()
      const last = await repository.lastCompletedRunAt()
      const parisHour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Paris' }).format(now))
      if (parisHour >= 3 && (last === null || now.getTime() - last.getTime() > 23 * 3_600_000)) await reconciliation.execute({ now })
    }, app.log, 10 * 60_000)
    app.addHook('onClose', () => { stopReconciliationWorker() })
  }
  // Lecture du règlement (R80) : livreur « Mes paiements », restaurant « Règlements », vue d'ensemble admin ; aucune écriture, aucune règle financière.
  const settlementRead = new PostgresSettlementReadRepository(pool)
  const settlementDirectory: SettlementDirectory = {
    merchantNames: async (ids) => new Map((await Promise.all(ids.map(async (id) => [id, (await merchants.findMerchantById(id))?.name ?? 'Restaurant'] as const)))),
    driverNames: async (ids) => new Map((await Promise.all(ids.map(async (id) => [id, (await drivers.findDriverById(id))?.name ?? 'Livreur'] as const)))),
    merchantLegalIdentity: async (id) => {
      const legal = await merchants.getLegalInformation(id)
      if (legal === null) return null
      const { legalAddress: a } = legal
      return { legalName: legal.legalName, siret: legal.siret, address: [a.line1, a.line2, `${a.postalCode} ${a.city}`].filter((part): part is string => part !== null && part !== '').join(', ') }
    }
  }
  const settlementClock = (): Date => new Date()
  const settlementCloseRepository = new PostgresSettlementCloseRepository(pool)
  const reversalRepository = new PostgresDriverReversalRepository(pool)
  await app.register(registerSettlementReadRoutes, {
    driverSettlements: new GetDriverSettlementsUseCase(settlementRead, settlementDirectory, new OrdersCurrentWeekEstimator(() => settlementCloseRepository.readSettings(), orders), settlementClock, config.SETTLEMENT_DRIVER_SEES_DEBTOR_IDENTITY),
    merchantSettlements: new GetMerchantSettlementsUseCase(settlementRead, settlementClock),
    merchantSettlementDetail: new GetMerchantSettlementDetailUseCase(settlementRead, settlementClock),
    adminOverview: new GetAdminOverviewUseCase(settlementRead, settlementDirectory, settlementClock),
    requestReversal: new RequestDriverReversalUseCase(reversalRepository),
    decideReversal: new DecideDriverReversalUseCase(reversalRepository),
    clock: settlementClock
  })
  // Opération admin minimale : relance MANUELLE d'un prélèvement restaurant échoué (ouvre une nouvelle pré-notification, ne débite rien).
  await app.register(registerSettlementAdminRoutes, { requestDebitRetry: new RequestDebitRetryUseCase(new PostgresDebitRetryRepository(pool)) })
  await app.register(registerAuthHttpRoutes, { merchants })
  await app.register(registerDriverHttpRoutes, { drivers })
  await app.register(registerOrderHttpRoutes, { orders, findMerchantById, findZoneById, findDriverById })
  await app.register(registerCashOnDeliveryHttpRoutes, { completion })
  await app.register(registerCardPaymentsHttpRoutes, { cardPayments })
  await app.register(registerDispatchHttpRoutes, { dispatch })

  app.get('/health', async () => ({ status: 'ok' }))

  return app
}
