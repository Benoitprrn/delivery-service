import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z, ZodError } from 'zod'
import {
  DriverConnectIdempotencyConflictError,
  DriverConnectOnboardingIncompleteError,
  DriverConnectProviderError,
  DriverConnectUnavailableError
} from '../../ports/driver-connect-provider.js'
import { DriverEntityTypeLockedError, DriverPayoutAccountNotFoundError, type DriverPayoutAccountUseCases } from '../../application/driver-payout-account.js'

const createBodySchema = z.object({ entityType: z.enum(['individual', 'company']) }).strict()
const accountSessionBodySchema = z.object({ purpose: z.enum(['onboarding', 'wallet']).optional() }).strict()

export type DriverPayoutRoutesOptions = {
  payoutAccount: Pick<DriverPayoutAccountUseCases, 'create' | 'get' | 'createOnboardingLink' | 'createAccountSession' | 'createDashboardLink'>
  /** Nom affiché du livreur, transmis à Stripe (`display_name`) ; `null` si le profil n'existe pas. */
  findDriverName: (driverId: string) => Promise<string | null>
}

function fail(request: FastifyRequest, reply: FastifyReply, statusCode: number, error: string, message: string) {
  return reply.code(statusCode).send({ error, message, correlationId: request.correlationId })
}

function mapError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) return fail(request, reply, 400, 'InvalidRequest', 'Invalid request body')
  if (error instanceof DriverPayoutAccountNotFoundError) return fail(request, reply, 404, 'PayoutAccountNotFound', 'Payout account has not been created yet')
  if (error instanceof DriverEntityTypeLockedError) return fail(request, reply, 409, 'EntityTypeLocked', 'The entity type of the payout account cannot be changed')
  if (error instanceof DriverConnectIdempotencyConflictError) return fail(request, reply, 409, 'PayoutAccountConflict', 'A payout account creation is already in progress with different parameters')
  if (error instanceof DriverConnectOnboardingIncompleteError) return fail(request, reply, 409, 'OnboardingNotCompleted', 'Complete the payout account onboarding first')
  if (error instanceof DriverConnectUnavailableError) return fail(request, reply, 503, 'StripeUnavailable', 'Payments are temporarily unavailable')
  if (error instanceof DriverConnectProviderError) return fail(request, reply, 502, 'StripeProviderError', 'The payment provider request failed')
  request.log.error({ err: error }, 'Driver payout account request failed')
  return fail(request, reply, 500, 'InternalError', 'An unexpected error occurred')
}

/** Routes `/api/v1/drivers/me/payout-account` : réservées au livreur authentifié ; jamais d'`acct_`, de montant ni de restaurant en entrée/sortie. */
export async function registerDriverPayoutRoutes(app: FastifyInstance, options: DriverPayoutRoutesOptions): Promise<void> {
  const driverId = (request: FastifyRequest, reply: FastifyReply): string | null => {
    if (request.authUser?.role !== 'driver') {
      fail(request, reply, 403, 'ForbiddenError', 'Only drivers can access this resource')
      return null
    }
    return request.authUser.id
  }

  app.get('/api/v1/drivers/me/payout-account', async (request, reply) => {
    const id = driverId(request, reply); if (id === null) return reply
    try { return reply.code(200).send(await options.payoutAccount.get(id)) } catch (error) { return mapError(request, reply, error) }
  })

  app.post('/api/v1/drivers/me/payout-account', async (request, reply) => {
    const id = driverId(request, reply); if (id === null) return reply
    try {
      const { entityType } = createBodySchema.parse(request.body)
      const displayName = await options.findDriverName(id)
      if (displayName === null) return fail(request, reply, 404, 'DriverNotFoundError', 'Driver profile was not found')
      return reply.code(200).send(await options.payoutAccount.create({ driverId: id, entityType, displayName, contactEmail: request.authUser?.email }))
    } catch (error) { return mapError(request, reply, error) }
  })

  app.post('/api/v1/drivers/me/payout-account/onboarding-link', async (request, reply) => {
    const id = driverId(request, reply); if (id === null) return reply
    try { return reply.code(200).send(await options.payoutAccount.createOnboardingLink(id)) } catch (error) { return mapError(request, reply, error) }
  })

  app.post('/api/v1/drivers/me/payout-account/account-session', async (request, reply) => {
    const id = driverId(request, reply); if (id === null) return reply
    try {
      const { purpose = 'onboarding' } = accountSessionBodySchema.parse(request.body ?? {})
      return reply.code(200).send(await options.payoutAccount.createAccountSession(id, purpose))
    } catch (error) { return mapError(request, reply, error) }
  })

  app.post('/api/v1/drivers/me/payout-account/dashboard-link', async (request, reply) => {
    const id = driverId(request, reply); if (id === null) return reply
    try { return reply.code(200).send(await options.payoutAccount.createDashboardLink(id)) } catch (error) { return mapError(request, reply, error) }
  })
}
