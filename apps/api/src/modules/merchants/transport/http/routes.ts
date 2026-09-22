import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createMerchantsModule } from '../../public.js'
import { mapErrorToHttp } from './error-handler.js'
import { AmbiguousMerchantZoneError } from '../../domain/errors.js'
import { isMerchantInformationComplete } from '../../domain/merchant.js'
import { sireneLookupBodySchema, updateLegalInformationBodySchema, updateMerchantBodySchema } from './schemas.js'
import { isMerchantLegalInformationComplete } from '../../application/legal-information.js'

type MerchantsHttpRoutesOptions = {
  merchants: ReturnType<typeof createMerchantsModule>
}

function sendMappedError(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AmbiguousMerchantZoneError) {
    request.log.error({ point: error.point, zones: error.zones }, 'Merchant address matches multiple zones')
  }
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
    phonePrimary: merchant.phonePrimary,
    phoneSecondary: merchant.phoneSecondary,
    logoUrl: merchant.logoUrl,
    address: merchant.address,
    lat: merchant.lat,
    lng: merchant.lng,
    zoneId: merchant.zoneId,
    merchantInformationCompleted: isMerchantInformationComplete(merchant),
    onboardingCompleted: merchant.onboardingCompleted
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
      const merchant = await options.merchants.updateMerchantInformation(request.authUser.id, body)
      return reply.code(200).send(merchantResponse(merchant))
    } catch (error) {
      return sendMappedError(request, reply, error)
    }
  })

  const legalResponse = (legal: Awaited<ReturnType<MerchantsHttpRoutesOptions['merchants']['getLegalInformation']>>) => legal === null ? { legalInformation: null, merchantLegalInformationCompleted: false } : { legalInformation: { siret: legal.siret, siren: legal.siren, legalName: legal.legalName, legalAddress: legal.legalAddress, billingAddress: legal.billingAddress, vatNumber: legal.vatNumber, sireneVerificationStatus: legal.sireneVerificationStatus, sireneVerifiedAt: legal.sireneVerifiedAt }, merchantLegalInformationCompleted: isMerchantLegalInformationComplete(legal) }
  app.get('/api/v1/merchants/me/legal-information', async (request, reply) => { try { if (request.authUser === undefined) throw new Error('Authenticated user is missing'); if (request.authUser.role !== 'merchant') return sendForbidden(reply, request.correlationId); return reply.send(legalResponse(await options.merchants.getLegalInformation(request.authUser.id))) } catch (error) { return sendMappedError(request, reply, error) } })
  app.post('/api/v1/merchants/me/legal-information/siret-lookup', async (request, reply) => { try { if (request.authUser === undefined) throw new Error('Authenticated user is missing'); if (request.authUser.role !== 'merchant') return sendForbidden(reply, request.correlationId); const body=sireneLookupBodySchema.parse(request.body); const found=await options.merchants.lookupLegalInformation(request.authUser.id, body.siret); return reply.send({ siret: found.siret, siren: found.siren, legalName: found.legalName, legalAddress: found.legalAddress, sireneVerificationStatus: 'verified', warning: found.establishmentActive && found.legalUnitActive ? null : 'The establishment or legal unit is inactive' }) } catch (error) { return sendMappedError(request, reply, error) } })
  app.patch('/api/v1/merchants/me/legal-information', async (request, reply) => { try { if (request.authUser === undefined) throw new Error('Authenticated user is missing'); if (request.authUser.role !== 'merchant') return sendForbidden(reply, request.correlationId); const body=updateLegalInformationBodySchema.parse(request.body); return reply.send(legalResponse(await options.merchants.updateLegalInformation(request.authUser.id, body))) } catch (error) { return sendMappedError(request, reply, error) } })

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
