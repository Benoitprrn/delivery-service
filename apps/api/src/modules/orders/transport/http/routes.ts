import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createMerchantsModule } from '../../../merchants/public.js'
import { createDriversModule } from '../../../drivers/public.js'
import { createZonesModule } from '../../../zones/public.js'
import { createOrdersModule, MerchantNotFoundError } from '../../public.js'
import { mapErrorToHttp } from './error-handler.js'
import {
  createOrderBodySchema,
  completeOrderBodySchema,
  emptyQuerySchema,
  estimateOrderQuerySchema,
  listAvailableOrdersQuerySchema,
  orderIdParamsSchema,
  orderTransitionBodySchema
} from './schemas.js'

type OrdersHttpRoutesOptions = {
  orders: Omit<ReturnType<typeof createOrdersModule>,
    'getOrderTracking' | 'findActiveTrackingTokensByDriverId' |
    'findDriversWithActiveOrderForMerchant' | 'recordDispatchAttempt' | 'markDispatchFailed' |
    'findOrderById' | 'findDispatchMetadata' | 'findStuckAvailableOrders'
  > &
    Partial<Pick<ReturnType<typeof createOrdersModule>, 'getOrderTracking'>>
  findMerchantById: ReturnType<typeof createMerchantsModule>['findMerchantById']
  findZoneById: ReturnType<typeof createZonesModule>['findZoneById']
  findDriverById: ReturnType<typeof createDriversModule>['findDriverById']
}

function sendMappedError(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  const { statusCode, body } = mapErrorToHttp(error, request.correlationId)
  request.log.error({ err: error, statusCode }, 'HTTP request failed')
  return reply.code(statusCode).send(body)
}

export async function registerOrderHttpRoutes(
  app: FastifyInstance,
  options: OrdersHttpRoutesOptions
): Promise<void> {
  app.addHook('onRequest', async (request) => {
    request.log.info({ method: request.method, url: request.url }, 'HTTP request started')
  })
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      { statusCode: reply.statusCode, durationMs: reply.elapsedTime },
      'HTTP request completed'
    )
  })

  app.post('/api/v1/orders', async (request, reply) => {
    try {
      const body = createOrderBodySchema.parse(request.body)
      const { merchantId, ...command } = body
      const merchant = await options.findMerchantById(merchantId)
      if (merchant === null) {
        throw new MerchantNotFoundError(`Merchant ${merchantId} not found`)
      }

      const zone = await options.findZoneById(merchant.zoneId)
      if (zone === null) {
        throw new Error(`Zone ${merchant.zoneId} not found`)
      }

      const order = await options.orders.createOrder({
        ...command,
        merchant,
        zone,
        correlationId: request.correlationId
      })
      return reply.code(201).send(order)
    } catch (error) {
      return sendMappedError(request, reply, error)
    }
  })

  app.get('/api/v1/orders/available', async (request, reply) => {
    try {
      const { zoneId } = listAvailableOrdersQuerySchema.parse(request.query)
      if (request.authUser?.role !== 'driver') {
        return reply.code(403).send({ error: 'ForbiddenError', message: 'Only drivers can access this resource', correlationId: request.correlationId })
      }
      const driver = await options.findDriverById(request.authUser.id)
      if (driver === null) {
        return reply.code(404).send({
          error: 'DriverNotFoundError',
          message: 'Driver profile was not found',
          correlationId: request.correlationId
        })
      }
      if (zoneId !== driver.zoneId) {
        return reply.code(403).send({ error: 'ForbiddenError', message: 'Drivers can only access orders in their zone', correlationId: request.correlationId })
      }
      const orders = await options.orders.listAvailableOrders({ driverId: request.authUser.id, zoneId })
      return reply.code(200).send(orders)
    } catch (error) {
      return sendMappedError(request, reply, error)
    }
  })

  app.get('/api/v1/orders/estimate', async (request, reply) => {
    try {
      const { deliveryAddress } = estimateOrderQuerySchema.parse(request.query)
      if (request.authUser === undefined) {
        throw new Error('Authenticated user is missing')
      }

      const merchantId = request.authUser.id
      const merchant = await options.findMerchantById(merchantId)
      if (merchant === null) {
        throw new MerchantNotFoundError(`Merchant ${merchantId} not found`)
      }

      const zone = await options.findZoneById(merchant.zoneId)
      if (zone === null) {
        throw new Error(`Zone ${merchant.zoneId} not found`)
      }

      const estimate = await options.orders.estimateOrder({ merchant, zone, deliveryAddress })
      return reply.code(200).send(estimate)
    } catch (error) {
      return sendMappedError(request, reply, error)
    }
  })

  app.get('/api/v1/orders/track/:token', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    const token = (request.params as { token?: string }).token
    // Do not validate UUID syntax here: malformed and unknown values both map
    // to the same 404 response, so the endpoint reveals nothing about tokens.
    const tracking = token === undefined || options.orders.getOrderTracking === undefined
      ? null
      : await options.orders.getOrderTracking(token)
    if (tracking === null) return reply.code(404).send({ error: 'OrderNotFound' })
    return reply.code(200).send(tracking)
  })

  app.get('/api/v1/orders/merchant', async (request, reply) => {
    try {
      if (request.authUser === undefined) {
        throw new Error('Authenticated user is missing')
      }
      if (request.authUser.role !== 'merchant') {
        return reply.code(403).send({
          error: 'ForbiddenError',
          message: 'Only merchants can access this resource',
          correlationId: request.correlationId
        })
      }

      const merchantId = request.authUser.id
      const merchant = await options.findMerchantById(merchantId)
      if (merchant === null) {
        throw new MerchantNotFoundError(`Merchant ${merchantId} not found`)
      }

      const orders = await options.orders.getMerchantOrders(merchantId)
      return reply.code(200).send({ zoneId: merchant.zoneId, orders })
    } catch (error) {
      return sendMappedError(request, reply, error)
    }
  })

  app.get('/api/v1/orders/driver', async (request, reply) => {
    try {
      if (request.authUser === undefined) {
        throw new Error('Authenticated user is missing')
      }
      if (request.authUser.role !== 'driver') {
        return reply.code(403).send({
          error: 'ForbiddenError',
          message: 'Only drivers can access this resource',
          correlationId: request.correlationId
        })
      }
      const orders = await options.orders.getDriverOrders(request.authUser.id)
      return reply.code(200).send({ orders })
    } catch (error) {
      return sendMappedError(request, reply, error)
    }
  })

  app.get('/api/v1/orders/driver/history', async (request, reply) => {
    try {
      if (request.authUser === undefined) {
        throw new Error('Authenticated user is missing')
      }
      if (request.authUser.role !== 'driver') {
        return reply.code(403).send({
          error: 'ForbiddenError',
          message: 'Only drivers can access this resource',
          correlationId: request.correlationId
        })
      }
      emptyQuerySchema.parse(request.query)
      const orders = await options.orders.getDriverHistory(request.authUser.id)
      return reply.code(200).send({ orders })
    } catch (error) {
      return sendMappedError(request, reply, error)
    }
  })

  app.get('/api/v1/orders/driver/earnings', async (request, reply) => {
    try {
      if (request.authUser === undefined) {
        throw new Error('Authenticated user is missing')
      }
      if (request.authUser.role !== 'driver') {
        return reply.code(403).send({
          error: 'ForbiddenError',
          message: 'Only drivers can access this resource',
          correlationId: request.correlationId
        })
      }
      emptyQuerySchema.parse(request.query)
      const earnings = await options.orders.getDriverEarnings(request.authUser.id)
      return reply.code(200).send(earnings)
    } catch (error) {
      return sendMappedError(request, reply, error)
    }
  })

  app.get('/api/v1/orders/:id/route', async (request, reply) => {
    try {
      const { id } = orderIdParamsSchema.parse(request.params)
      if (request.authUser?.role !== 'driver') {
        return reply.code(403).send({ error: 'ForbiddenError', message: 'Only drivers can access this resource', correlationId: request.correlationId })
      }
      const driver = await options.findDriverById(request.authUser.id)
      if (driver === null) {
        return reply.code(404).send({
          error: 'DriverNotFoundError',
          message: 'Driver profile was not found',
          correlationId: request.correlationId
        })
      }
      const geometry = await options.orders.getOrderRoute({ orderId: id, driverZoneId: driver.zoneId })
      return reply.code(200).send({ geometry })
    } catch (error) {
      return sendMappedError(request, reply, error)
    }
  })

  app.post('/api/v1/orders/:id/collect', async (request, reply) => {
    try {
      const { id } = orderIdParamsSchema.parse(request.params)
      const body = orderTransitionBodySchema.parse(request.body)
      if (request.authUser?.role !== 'driver') {
        return reply.code(403).send({ error: 'ForbiddenError', message: 'Only drivers can perform this action', correlationId: request.correlationId })
      }
      const order = await options.orders.collectOrder({
        orderId: id,
        ...body,
        driverId: request.authUser.id,
        actor: { type: 'driver', id: request.authUser.id },
        correlationId: request.correlationId
      })
      return reply.code(200).send(order)
    } catch (error) {
      return sendMappedError(request, reply, error)
    }
  })

  app.post('/api/v1/orders/:id/complete', async (request, reply) => {
    try {
      const { id } = orderIdParamsSchema.parse(request.params)
      const body = completeOrderBodySchema.parse(request.body)
      if (request.authUser?.role !== 'driver') {
        return reply.code(403).send({ error: 'ForbiddenError', message: 'Only drivers can perform this action', correlationId: request.correlationId })
      }
      const order = await options.orders.completeOrder({
        orderId: id,
        ...body,
        driverId: request.authUser.id,
        actor: { type: 'driver', id: request.authUser.id },
        correlationId: request.correlationId
      })
      return reply.code(200).send(order)
    } catch (error) {
      return sendMappedError(request, reply, error)
    }
  })

  app.post('/api/v1/orders/:id/return', async (request, reply) => {
    try {
      const { id } = orderIdParamsSchema.parse(request.params)
      const body = orderTransitionBodySchema.parse(request.body)
      if (request.authUser?.role !== 'driver') {
        return reply.code(403).send({ error: 'ForbiddenError', message: 'Only drivers can perform this action', correlationId: request.correlationId })
      }
      const order = await options.orders.returnOrder({
        orderId: id,
        ...body,
        driverId: request.authUser.id,
        actor: { type: 'driver', id: request.authUser.id },
        correlationId: request.correlationId
      })
      return reply.code(200).send(order)
    } catch (error) {
      return sendMappedError(request, reply, error)
    }
  })

  app.post('/api/v1/orders/:id/returned', async (request, reply) => {
    try {
      const { id } = orderIdParamsSchema.parse(request.params)
      const body = orderTransitionBodySchema.parse(request.body)
      if (request.authUser?.role !== 'driver') {
        return reply.code(403).send({ error: 'ForbiddenError', message: 'Only drivers can perform this action', correlationId: request.correlationId })
      }
      const order = await options.orders.confirmReturn({
        orderId: id,
        ...body,
        driverId: request.authUser.id,
        actor: { type: 'driver', id: request.authUser.id },
        correlationId: request.correlationId
      })
      return reply.code(200).send(order)
    } catch (error) {
      return sendMappedError(request, reply, error)
    }
  })
}
