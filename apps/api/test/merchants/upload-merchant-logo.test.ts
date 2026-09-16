import { describe, expect, it, vi } from 'vitest'
import { UploadMerchantLogoUseCase } from '../../src/modules/merchants/application/upload-merchant-logo.js'

describe('UploadMerchantLogoUseCase', () => {
  it('stores a supported logo then persists its public URL', async () => {
    const upload = vi.fn().mockResolvedValue('https://storage.example/merchant-logos/merchants/merchant-1/logo')
    const updateLogoUrl = vi.fn().mockResolvedValue({ id: 'merchant-1' })
    const useCase = new UploadMerchantLogoUseCase(
      { findById: vi.fn(), update: vi.fn(), updateLogoUrl },
      { upload }
    )

    await expect(useCase.execute('merchant-1', Buffer.from('image'), 'image/png')).resolves.toEqual({ id: 'merchant-1' })
    expect(upload).toHaveBeenCalledWith({ merchantId: 'merchant-1', content: Buffer.from('image'), contentType: 'image/png' })
    expect(updateLogoUrl).toHaveBeenCalledWith('merchant-1', 'https://storage.example/merchant-logos/merchants/merchant-1/logo')
  })

  it.each(['image/gif', 'text/plain'])('rejects an unsupported content type', async (contentType) => {
    const useCase = new UploadMerchantLogoUseCase(
      { findById: vi.fn(), update: vi.fn(), updateLogoUrl: vi.fn() },
      { upload: vi.fn() }
    )

    await expect(useCase.execute('merchant-1', Buffer.from('image'), contentType)).rejects.toThrow('JPEG or PNG')
  })
})
