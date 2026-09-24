import type { Pool } from 'pg'
import type { DriverEInvoiceReadinessReader } from '../application/driver-einvoice-readiness.js'

/** Transmission-only mandate check; it is never used by order dispatch/readiness. */
export class PostgresDriverEInvoiceReadinessReader implements DriverEInvoiceReadinessReader {
  public constructor(private readonly pool: Pool) {}

  public async hasVerifiedMandate(driverId: string): Promise<boolean> {
    const result = await this.pool.query(
      `select 1 from driver_einvoice_mandates
       where driver_id = $1 and revoked_at is null and provider_verification_status = 'verified'
       limit 1`,
      [driverId]
    )
    return result.rowCount === 1
  }
}
