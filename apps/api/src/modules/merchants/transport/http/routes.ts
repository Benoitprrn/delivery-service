import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createMerchantsModule } from '../../public.js'
import { mapErrorToHttp } from './error-handler.js'
import { updateMerchantBodySchema } from './schemas.js'

type MerchantsHttpRoutesOptions = {
  merchants: ReturnType<typeof createMerchantsModule>
}

function sendMappedError(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  const { statusCode, body } = mapErrorToHttp(error, request.correlationId)
  request.log.error({ err: error, statusCode }, 'HTTP request failed')
  return reply.code(statusCode).send(body)
}

function sendForbidden(reply: FastifyReply, correlationId: string): FastifyReply {
  return reply.code(403).send({
    error: 'ForbiddenError',
    message: 'Only merchants can access this resource',
    correlationId
  })
}

function merchantResponse(merchant: Awaited<ReturnType<MerchantsHttpRoutesOptions['merchants']['getMerchant']>>) {
  return {
    name: merchant.name,
    phoneLandline: merchant.phoneLandline,
    phoneMobile: merchant.phoneMobile,
    logoUrl: merchant.logoUrl,
    address: merchant.address,
    lat: merchant.lat,
    lng: merchant.lng
  }
}

export async function registerMerchantHttpRoutes(
  app: FastifyInstance,
  options: MerchantsHttpRoutesOptions
): Promise<void> {
  app.get('/api/v1/merchants/me', async (request, reply) => {
    try {
      if (request.authUser === undefined) {
        throw new Error('Authenticated user is missing')
      }
      if (request.authUser.role !== 'merchant') {
        return sendForbidden(reply, request.correlationId)
      }
      const merchant = await options.merchants.getMerchant(request.authUser.id)
      return reply.code(200).send(merchantResponse(merchant))
    } catch (error) {
      return sendMappedError(request, reply, error)
    }
  })

  app.patch('/api/v1/merchants/me', async (request, reply) => {
    try {
      if (request.authUser === undefined) {
        throw new Error('Authenticated user is missing')
      }
      if (request.authUser.role !== 'merchant') {
        return sendForbidden(reply, request.correlationId)
      }
      const body = updateMerchantBodySchema.parse(request.body)
      const merchant = await options.merchants.updateMerchant(request.authUser.id, body)
      return reply.code(200).send(merchantResponse(merchant))
    } catch (error) {
      return sendMappedError(request, reply, error)
    }
  })

  app.post('/api/v1/merchants/me/logo', async (request, reply) => {
    try {
      if (request.authUser === undefined) throw new Error('Authenticated user is missing')
      if (request.authUser.role !== 'merchant') return sendForbidden(reply, request.correlationId)
      const file = await request.file()
      if (file === undefined) return reply.code(400).send({ error: 'ValidationError', message: 'Logo file is required', correlationId: request.correlationId })
      const merchant = await options.merchants.uploadLogo(request.authUser.id, await file.toBuffer(), file.mimetype)
      return reply.code(200).send(merchantResponse(merchant))
    } catch (error) {
      return sendMappedError(request, reply, error)
    }
  })
}
