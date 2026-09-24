import { selectBuyerDirectoryEntry, type DirectoryResolution } from '../domain/directory-selection.js'
import type { EInvoiceDirectoryCacheRepository } from '../ports/einvoice-directory-cache.js'
import type { FrenchDirectoryProvider } from '../ports/french-directory-provider.js'

export interface BuyerElectronicAddressResolver { resolve(merchantId: string, siren: string, now: Date): Promise<DirectoryResolution> }
export class RefreshBuyerElectronicAddressUseCase implements BuyerElectronicAddressResolver {
  public constructor(private readonly cache: EInvoiceDirectoryCacheRepository, private readonly directory: FrenchDirectoryProvider, private readonly staleAfterMs = 24 * 60 * 60 * 1000) {}
  public async resolve(merchantId: string, siren: string, now: Date): Promise<DirectoryResolution> {
    const cached = await this.cache.read(merchantId)
    if (cached !== null && cached.siren === siren && now.getTime() - cached.checkedAt.getTime() < this.staleAfterMs) return cached.resolution
    return this.refresh(merchantId, siren, now)
  }
  public async refresh(merchantId: string, siren: string, now: Date): Promise<DirectoryResolution> {
    let resolution: DirectoryResolution
    try { resolution = selectBuyerDirectoryEntry(await this.directory.lookupBySiren(siren)) } catch { resolution = { status: 'lookup_failed' } }
    await this.cache.upsert(merchantId, { siren, resolution, checkedAt: now })
    return resolution
  }
}
