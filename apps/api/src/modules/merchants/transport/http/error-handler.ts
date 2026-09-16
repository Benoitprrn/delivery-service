import { ZodError } from 'zod'
import { MerchantNotFoundError } from '../../domain/errors.js'
import { InvalidMerchantLogoError } from '../../domain/invalid-merchant-logo-error.js'

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
  if (error instanceof ZodError) {
    const isMissingContact = error.issues.some((issue) => issue.message === 'At least one phone number is required')
    return {
      statusCode: isMissingContact ? 422 : 400,
      body: { error: 'ValidationError', message: isMissingContact ? 'At least one phone number is required' : 'Request validation failed', correlationId }
    }
  }
  if (error instanceof InvalidMerchantLogoError) return mappedError(422, error, correlationId)
  return {
    statusCode: 500,
    body: { error: 'InternalServerError', message: 'An unexpected error occurred', correlationId }
  }
}
