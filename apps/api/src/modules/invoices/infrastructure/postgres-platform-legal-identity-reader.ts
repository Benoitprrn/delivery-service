import type { Pool } from 'pg'
import type { PlatformLegalIdentityReader } from '../ports/platform-legal-identity-reader.js'
import type { MandateSeller } from '../ports/mandate-pdf-renderer.js'
export class PostgresPlatformLegalIdentityReader implements PlatformLegalIdentityReader {
  public constructor(private readonly pool: Pool) {}
  public async findPlatformLegalIdentity(): Promise<MandateSeller | null> {
    const row = (await this.pool.query<{ legal_name: string; siren: string; siret: string | null; address_line1: string; address_line2: string | null; address_postal_code: string; address_city: string; address_country_code: string }>(`select legal_name, siren, siret, address_line1, address_line2, address_postal_code, address_city, address_country_code from platform_legal_identity where id = true and legal_name is not null and siren is not null and siret is not null and vat_regime is not null and address_line1 is not null and address_postal_code is not null and address_city is not null and (vat_regime <> 'assujetti' or nullif(btrim(vat_number), '') is not null)`)).rows[0]
    return row === undefined ? null : { legalName: row.legal_name, siren: row.siren, siret: row.siret, addressLine1: row.address_line1, addressLine2: row.address_line2, postalCode: row.address_postal_code, city: row.address_city, countryCode: row.address_country_code }
  }
}
