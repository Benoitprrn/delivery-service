import { describe, expect, it } from 'vitest'
import { PollEInvoiceMandatesUseCase } from '../../src/modules/invoices/application/poll-einvoice-mandates.js'
import { RunEInvoiceMandateSubmissionsUseCase } from '../../src/modules/invoices/application/run-einvoice-mandate-submissions.js'
import { EInvoiceNetworkBeforeSendError, EInvoiceUnknownOutcomeError } from '../../src/modules/invoices/ports/einvoice-provider.js'

type Status = 'prepared' | 'submitting' | 'submitted' | 'retryable' | 'failed' | 'unknown_outcome'
function repository(status: Status = 'prepared') {
  const state = { status, calls: [] as string[], verifiedAt: null as Date | null, verification: 'submitted' as 'submitted' | 'not_verified' | 'verified' }
  const work = { id: 'm1', driverId: 'd1', grantorSiren: '123456789', grantorLegalName: 'Driver', signedPdfStoragePath: 'm.pdf', attempts: 1 }
  return {
    state,
    async claimDue() { return state.status === 'prepared' || state.status === 'retryable' ? [work] : [] },
    async submitted() { state.calls.push('submitted'); state.status = 'submitted' },
    async retryable() { state.calls.push('retryable'); state.status = 'retryable' },
    async failed() { state.calls.push('failed'); state.status = 'failed' },
    async unknownOutcome() { state.calls.push('unknown'); state.status = 'unknown_outcome' },
    async dueForVerification() { return [{ id: 'm1', providerMandateId: 'p1' }, { id: 'm2', providerMandateId: 'p2' }] },
    async applyVerification(input: { id: string; verificationStatus: 'verified' | 'not_verified'; now: Date }) { state.verification = input.verificationStatus; if (input.verificationStatus === 'verified') state.verifiedAt ??= input.now }
  }
}

describe('e-invoice mandate submission', () => {
  for (const [name, failure, expected] of [['submits successfully', null, 'submitted'], ['retries a before-send failure', new EInvoiceNetworkBeforeSendError('network'), 'retryable'], ['records an unknown outcome', new EInvoiceUnknownOutcomeError('timeout'), 'unknown'], ['fails a terminal error', new Error('bad request'), 'failed']] as const) {
    it(name, async () => { const r = repository(); const provider = { createMandate: async () => { if (failure !== null) throw failure; return { id: 'p1', verificationStatus: 'not_verified' as const } } }; await new RunEInvoiceMandateSubmissionsUseCase(r, { downloadMandatePdf: async () => Buffer.from('pdf'), uploadMandatePdf: async () => '', createSignedMandatePdfUrl: async () => '' }, provider as never, { grantorNumberScheme: 'fr_siren' }).execute(new Date()); expect(r.state.calls).toEqual([expected]) })
  }
  it('never reclaims a submitted or unknown-outcome mandate', async () => { const r = repository('submitted'); const useCase = new RunEInvoiceMandateSubmissionsUseCase(r, { downloadMandatePdf: async () => Buffer.from('pdf'), uploadMandatePdf: async () => '', createSignedMandatePdfUrl: async () => '' }, { createMandate: async () => ({ id: 'p1', verificationStatus: 'not_verified' as const }) } as never, { grantorNumberScheme: 'fr_siren' }); await useCase.execute(); r.state.status = 'unknown_outcome'; await useCase.execute(); expect(r.state.calls).toEqual([]) })
})

describe('e-invoice mandate polling', () => {
  it('keeps polling after one provider error and records verification', async () => { const r = repository(); const now = new Date(); let count = 0; await new PollEInvoiceMandatesUseCase(r, { getMandate: async () => { count++; if (count === 1) throw new Error('temporary'); return { id: 'p2', verificationStatus: 'verified' as const } } } as never).execute(now); expect(r.state.verification).toBe('verified'); expect(r.state.verifiedAt).toEqual(now) })
  it('keeps not_verified without a verified timestamp', async () => { const r = repository(); await r.applyVerification({ id: 'm1', verificationStatus: 'not_verified', now: new Date() }); expect(r.state.verification).toBe('not_verified'); expect(r.state.verifiedAt).toBeNull() })
})
