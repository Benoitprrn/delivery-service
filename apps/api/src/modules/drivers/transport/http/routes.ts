import type { FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import type { createDriversModule } from '../../public.js'
import { driverAvailabilityBodySchema, driverLocationBodySchema } from './schemas.js'

type DriversHttpRoutesOptions = {
  drivers: ReturnType<typeof createDriversModule>
}

export async function registerDriverHttpRoutes(
  app: FastifyInstance,
  options: DriversHttpRoutesOptions
): Promise<void> {
  app.get('/api/v1/drivers/me', async (request, reply) => {
    try {
      if (request.authUser?.role !== 'driver') {
        return reply.code(403).send({
          error: 'ForbiddenError',
          message: 'Only drivers can access this resource',
          correlationId: request.correlationId
        })
      }

      const driver = await options.drivers.getLiveDriverProfile(request.authUser.id)
      if (driver === null) {
        return reply.code(404).send({
          error: 'DriverNotFoundError',
          message: 'Driver profile was not found',
          correlationId: request.correlationId
        })
      }

      return reply.code(200).send(driver)
    } catch (error) {
      request.log.error({ err: error }, 'Driver profile lookup failed')
      return reply.code(500).send({
        error: 'InternalServerError',
        message: 'An unexpected error occurred',
        correlationId: request.correlationId
      })
    }
  })

  app.post('/api/v1/drivers/availability', async (request, reply) => {
    try {
      if (request.authUser?.role !== 'driver') {
        return reply.code(403).send({ error: 'ForbiddenError', message: 'Only drivers can update availability', correlationId: request.correlationId })
      }
      const { available } = driverAvailabilityBodySchema.parse(request.body)
      return reply.code(200).send(await options.drivers.setAvailability(request.authUser.id, available))
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.code(400).send({ error: 'ValidationError', message: 'Request validation failed', correlationId: request.correlationId })
      }
      request.log.error({ err: error }, 'Driver availability write failed')
      return reply.code(500).send({ error: 'InternalServerError', message: 'An unexpected error occurred', correlationId: request.correlationId })
    }
  })

  app.post('/api/v1/drivers/heartbeat', async (request, reply) => {
    try {
      if (request.authUser?.role !== 'driver') {
        return reply.code(403).send({ error: 'ForbiddenError', message: 'Only drivers can send heartbeats', correlationId: request.correlationId })
      }
      await options.drivers.heartbeat(request.authUser.id)
      return reply.code(204).send()
    } catch (error) {
      request.log.error({ err: error }, 'Driver heartbeat failed')
      return reply.code(500).send({ error: 'InternalServerError', message: 'An unexpected error occurred', correlationId: request.correlationId })
    }
  })

  app.post('/api/v1/drivers/location', async (request, reply) => {
    try {
      if (request.authUser?.role !== 'driver') {
        return reply.code(403).send({
          error: 'ForbiddenError',
          message: 'Only drivers can record their location',
          correlationId: request.correlationId
        })
      }

      const body = driverLocationBodySchema.parse(request.body)
      await options.drivers.recordLocation({ ...body, driverId: request.authUser.id })
      return reply.code(204).send()
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.code(400).send({
          error: 'ValidationError',
          message: 'Request validation failed',
          correlationId: request.correlationId
        })
      }
      request.log.error({ err: error }, 'Driver location write failed')
      return reply.code(500).send({
        error: 'InternalServerError',
        message: 'An unexpected error occurred',
        correlationId: request.correlationId
      })
    }
  })
}
