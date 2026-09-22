import { ZodError } from 'zod'
import { AddressOutsideZoneError, AmbiguousMerchantZoneError, MerchantNotFoundError } from '../../domain/errors.js'
import { AddressNotFoundError, GeocodingProviderResponseError, GeocodingUnavailableError } from '../../../geocoding/public.js'
import { InvalidMerchantLogoError } from '../../domain/invalid-merchant-logo-error.js'
import { InvalidSiretError } from '../../application/legal-information.js'
import { SiretNotFoundError, SireneProviderResponseError, SireneRestrictedError, SireneUnavailableError } from '../../ports/sirene-provider.js'

type ErrorBody = {
  error: string
  message: string
  correlationId: string
}

type HttpError = {
  statusCode: number
  body: ErrorBody
}

function mappedError(statusCode: number, error: Error, correlationId: string): HttpError {
  return {
    statusCode,
    body: { error: error.name, message: error.message, correlationId }
  }
}

export function mapErrorToHttp(error: unknown, correlationId: string): HttpError {
  if (error instanceof MerchantNotFoundError) {
    return mappedError(404, error, correlationId)
  }
  if (error instanceof AddressOutsideZoneError || error instanceof AmbiguousMerchantZoneError || error instanceof AddressNotFoundError) return mappedError(422, error, correlationId)
  if (error instanceof GeocodingProviderResponseError) return mappedError(502, error, correlationId)
  if (error instanceof GeocodingUnavailableError) return mappedError(503, error, correlationId)
  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      body: { error: 'ValidationError', message: 'Request validation failed', correlationId }
    }
  }
  if (error instanceof InvalidMerchantLogoError) return mappedError(422, error, correlationId)
  if (error instanceof InvalidSiretError) return mappedError(400, error, correlationId)
  if (error instanceof SiretNotFoundError) return mappedError(422, error, correlationId)
  if (error instanceof SireneRestrictedError) return mappedError(422, error, correlationId)
  if (error instanceof SireneUnavailableError) return mappedError(503, error, correlationId)
  if (error instanceof SireneProviderResponseError) return mappedError(502, error, correlationId)
  return {
    statusCode: 500,
    body: { error: 'InternalServerError', message: 'An unexpected error occurred', correlationId }
  }
}
