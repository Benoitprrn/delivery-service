import type { Pool } from 'pg'
import type { DriverInvoiceReadiness } from '../ports/driver-invoice-readiness.js'

export class PostgresDriverInvoiceReadinessReader implements DriverInvoiceReadiness {
  public constructor(private readonly pool: Pool) {}

  public async isReady(driverId: string): Promise<boolean> {
    const result = await this.pool.query<{ ready: boolean }>(
      `select exists (
         select 1
         from drivers d
         join driver_legal_information li on li.driver_id = d.id
         where d.id = $1
           and nullif(btrim(d.first_name), '') is not null
           and nullif(btrim(d.last_name), '') is not null
           and li.vat_regime is not null
           and (li.vat_regime <> 'assujetti' or nullif(btrim(li.vat_number), '') is not null)
       ) as ready`,
      [driverId]
    )
    return result.rows[0]?.ready === true
  }
}
