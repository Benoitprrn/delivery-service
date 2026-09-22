import Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import { buildTransferDescription, classifyTransferError, MAX_TRANSFER_TRIES, parseLocalDate, ProviderDriverAccountLiveReader, toTransferResult, TransferRejectedError, TransferTransientError, transferRetryDelaySeconds } from '../../../src/modules/settlements/public.js'

describe('driver payout helpers', () => {
  it('backs off 15 min, 30 min, 1 h… capped at 6 h and refuses invalid counts', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(transferRetryDelaySeconds)).toEqual([900, 1800, 3600, 7200, 14400, 21600, 21600, 21600])
    expect(() => transferRetryDelaySeconds(0)).toThrow()
    expect(MAX_TRANSFER_TRIES).toBe(20)
  })
  it('describes the statement in French for the driver Dashboard', () => {
    expect(buildTransferDescription({ periodFirstDay: parseLocalDate('2026-08-24'), periodLastDay: parseLocalDate('2026-08-30'), statementId: '0a1b2c3d-1111-2222-3333-444455556666' })).toBe('Locadely — livraisons du 2026-08-24 au 2026-08-30 (relevé 0a1b2c3d)')
  })
})

describe('Stripe transfer error classification', () => {
  it('a bad request or a missing capability is a definitive refusal of THIS transfer (capability flagged)', () => {
    const invalid = classifyTransferError(new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', code: 'parameter_invalid', message: 'x' } as never))
    expect(invalid).toBeInstanceOf(TransferRejectedError)
    expect(invalid).toMatchObject({ code: 'parameter_invalid', capability: false })
    const capability = classifyTransferError(new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', code: 'insufficient_capabilities_for_transfer', message: 'x' } as never))
    expect(capability).toMatchObject({ capability: true })
    expect(classifyTransferError(new Stripe.errors.StripeIdempotencyError({ type: 'idempotency_error', message: 'x' } as never))).toMatchObject({ code: 'idempotency_mismatch' })
  })
  it('platform, transport and unknown errors leave the result UNKNOWN (same key replayed), never a rejection', () => {
    for (const error of [new Stripe.errors.StripeAPIError({ type: 'api_error', message: 'x' } as never), new Stripe.errors.StripeAuthenticationError({ type: 'authentication_error', message: 'x' } as never),
      new Stripe.errors.StripePermissionError({ type: 'invalid_request_error', message: 'x' } as never), new Stripe.errors.StripeRateLimitError({ type: 'rate_limit_error', message: 'x' } as never), new Error('socket hang up')]) {
      expect(classifyTransferError(error)).toBeInstanceOf(TransferTransientError)
    }
  })
  it('maps a Stripe transfer including the destination payment', () => {
    const transfer = { id: 'tr_1', amount: 380, currency: 'eur', destination: 'acct_1', source_transaction: 'py_1', destination_payment: 'py_dest', livemode: false } as unknown as Stripe.Transfer
    expect(toTransferResult(transfer)).toEqual({ transferId: 'tr_1', amountCents: 380, currency: 'eur', destinationAccountId: 'acct_1', sourceTransactionId: 'py_1', destinationPaymentId: 'py_dest', livemode: false })
  })
})

describe('ProviderDriverAccountLiveReader', () => {
  const reader = (transfers: string, requirements: string): ProviderDriverAccountLiveReader => new ProviderDriverAccountLiveReader({ getAccountStatus: async () => ({ accountId: 'acct', entityType: null, transfers, payouts: 'active', requirements } as never) })
  it('is ready only with active transfers and no blocking requirement', async () => {
    await expect(reader('active', 'none').isTransferReady('a')).resolves.toBe(true)
    await expect(reader('active', 'eventually_due').isTransferReady('a')).resolves.toBe(true)
    await expect(reader('restricted', 'none').isTransferReady('a')).resolves.toBe(false)
    await expect(reader('active', 'past_due').isTransferReady('a')).resolves.toBe(false)
  })
})
