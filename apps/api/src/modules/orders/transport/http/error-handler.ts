import { ZodError } from 'zod'
import {
  DeliveryOutsideZoneError,
  InvalidTransitionError,
  InvalidZoneAssignmentError,
  MerchantNotFoundError,
  OrderConflictError,
  OrderNotFoundError,
  OrderRouteAccessDeniedError,
  PastPickupScheduleError
} from '../../domain/errors.js'
import {
  DeliveryCodeExpiredError,
  DeliveryCodeInvalidError,
  DeliveryCodeLockedError
} from '../../domain/delivery-code.js'
import { InvalidProofOfDeliveryError } from '../../domain/proof-of-delivery.js'
import {
  AddressNotFoundError,
  GeocodingProviderResponseError,
  GeocodingUnavailableError
} from '../../ports/geocoding-provider.js'
import {
  RouteNotFoundError,
  RoutingProviderResponseError,
  RoutingUnavailableError
} from '../../ports/routing-provider.js'

type ErrorBody = {
  error: string
  message: string
  correlationId: string
  attemptsRemaining?: number
}

type HttpError = {
  statusCode: number
  body: ErrorBody
}

function mappedError(statusCode: number, error: Error, correlationId: string): HttpError {
  return {
    statusCode,
    body: {
      error: error.name,
      message: error.message,
      correlationId
    }
  }
}

export function mapErrorToHttp(error: unknown, correlationId: string): HttpError {
  if (error instanceof DeliveryCodeInvalidError) {
    return {
      statusCode: 422,
      body: { ...mappedError(422, error, correlationId).body, attemptsRemaining: error.attemptsRemaining }
    }
  }
  if (error instanceof DeliveryCodeExpiredError) {
    return mappedError(422, error, correlationId)
  }
  if (error instanceof DeliveryCodeLockedError) {
    return mappedError(423, error, correlationId)
  }
  if (error instanceof OrderConflictError) {
    return mappedError(409, error, correlationId)
  }
  if (error instanceof OrderRouteAccessDeniedError) {
    return mappedError(403, error, correlationId)
  }
  if (error instanceof OrderNotFoundError || error instanceof MerchantNotFoundError) {
    return mappedError(404, error, correlationId)
  }
  if (
    error instanceof InvalidTransitionError ||
    error instanceof InvalidZoneAssignmentError ||
    error instanceof DeliveryOutsideZoneError ||
    error instanceof PastPickupScheduleError ||
    error instanceof InvalidProofOfDeliveryError ||
    error instanceof AddressNotFoundError
  ) {
    return mappedError(422, error, correlationId)
  }
  if (error instanceof RouteNotFoundError) {
    return mappedError(422, error, correlationId)
  }
  if (error instanceof RoutingProviderResponseError) {
    return mappedError(502, error, correlationId)
  }
  if (error instanceof GeocodingProviderResponseError) {
    return mappedError(502, error, correlationId)
  }
  if (error instanceof RoutingUnavailableError) {
    return mappedError(503, error, correlationId)
  }
  if (error instanceof GeocodingUnavailableError) {
    return mappedError(503, error, correlationId)
  }
  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      body: {
        error: 'ValidationError',
        message: 'Request validation failed',
        correlationId
      }
    }
  }

  return {
    statusCode: 500,
    body: {
      error: 'InternalServerError',
      message: 'An unexpected error occurred',
      correlationId
    }
  }
}
