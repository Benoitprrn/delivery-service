import type { Pool } from 'pg'
import type { DirectoryResolution } from '../domain/directory-selection.js'
import type { DirectoryCacheEntry, EInvoiceDirectoryCacheRepository } from '../ports/einvoice-directory-cache.js'

type Row = { siren: string; resolution_status: DirectoryResolution['status']; electronic_address_scheme: string | null; electronic_address_value: string | null; checked_at: Date }
export class PostgresEInvoiceDirectoryCacheRepository implements EInvoiceDirectoryCacheRepository {
  public constructor(private readonly pool: Pool) {}
  public async read(merchantId: string): Promise<DirectoryCacheEntry | null> {
    const row = (await this.pool.query<Row>('select siren, resolution_status, electronic_address_scheme, electronic_address_value, checked_at from merchant_einvoice_directory_cache where merchant_id = $1', [merchantId])).rows[0]
    if (row === undefined) return null
    const resolution = resolutionFromRow(row)
    return { siren: row.siren, resolution, checkedAt: row.checked_at }
  }
  public async upsert(merchantId: string, entry: DirectoryCacheEntry): Promise<void> {
    const address = entry.resolution.status === 'ready' ? entry.resolution.electronicAddress : null
    await this.pool.query(`insert into merchant_einvoice_directory_cache (merchant_id, siren, resolution_status, electronic_address_scheme, electronic_address_value, checked_at)
      values ($1, $2, $3, $4, $5, $6) on conflict (merchant_id) do update set siren = excluded.siren, resolution_status = excluded.resolution_status, electronic_address_scheme = excluded.electronic_address_scheme, electronic_address_value = excluded.electronic_address_value, checked_at = excluded.checked_at, updated_at = now()`, [merchantId, entry.siren, entry.resolution.status, address?.scheme ?? null, address?.value ?? null, entry.checkedAt])
  }
}
function resolutionFromRow(row: Row): DirectoryResolution {
  if (row.resolution_status === 'ready') {
    if (row.electronic_address_scheme === null || row.electronic_address_value === null) throw new Error('Invalid ready e-invoice directory cache entry')
    return { status: 'ready', electronicAddress: { scheme: row.electronic_address_scheme, value: row.electronic_address_value } }
  }
  return { status: row.resolution_status }
}
