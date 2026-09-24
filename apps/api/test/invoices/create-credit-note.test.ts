import { describe, expect, it, vi } from 'vitest'
import { CreateCreditNoteUseCase } from '../../src/modules/invoices/public.js'

describe('CreateCreditNoteUseCase', () => {
  it('requires an explicit documented decision and delegates the database cumulative cap', async () => {
    const createCreditNote = vi.fn().mockResolvedValue({ id: 'credit', number: 'AVD-123456789-000001' })
    const useCase = new CreateCreditNoteUseCase({ createCreditNote } as never)
    await expect(useCase.execute({ originalInvoiceLineId: 'line', decisionReference: 'DEC-1', decisionReason: 'Correction', lineHtCents: 120 })).resolves.toMatchObject({ number: 'AVD-123456789-000001' })
    await expect(useCase.execute({ originalInvoiceLineId: 'line', decisionReference: ' ', decisionReason: 'Correction', lineHtCents: 120 })).rejects.toThrow('required')
    await expect(useCase.execute({ originalInvoiceLineId: 'line', decisionReference: 'DEC-1', decisionReason: 'Correction', lineHtCents: 0 })).rejects.toThrow('positive integer')
    expect(createCreditNote).toHaveBeenCalledTimes(1)
  })
})
