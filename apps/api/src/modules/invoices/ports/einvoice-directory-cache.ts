import type { DirectoryResolution } from '../domain/directory-selection.js'
export type DirectoryCacheEntry = { siren: string; resolution: DirectoryResolution; checkedAt: Date }
export interface EInvoiceDirectoryCacheRepository { read(merchantId: string): Promise<DirectoryCacheEntry | null>; upsert(merchantId: string, entry: DirectoryCacheEntry): Promise<void> }
