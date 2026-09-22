import type { Pool } from 'pg'
import type { DriverEntityType } from '../domain/driver-account.js'
import type { DriverConnectAccountRecord, DriverConnectRepository } from '../ports/driver-connect-repository.js'
import type { CapabilityState, RequirementsState } from '../ports/driver-connect-provider.js'

type Row = {
  driver_id: string
  stripe_account_id: string
  entity_type: DriverEntityType
  transfers_status: string
  payouts_status: string
  requirements_state: string
  restricted_at: Date | null
  last_synced_at: Date | null
}
const COLUMNS = 'driver_id, stripe_account_id, entity_type, transfers_status, payouts_status, requirements_state, restricted_at, last_synced_at'
const map = (row: Row): DriverConnectAccountRecord => ({
  driverId: row.driver_id,
  stripeAccountId: row.stripe_account_id,
  entityType: row.entity_type,
  transfersStatus: row.transfers_status,
  payoutsStatus: row.payouts_status,
  requirementsState: row.requirements_state,
  restrictedAt: row.restricted_at,
  lastSyncedAt: row.last_synced_at
})

export class PostgresDriverConnectRepository implements DriverConnectRepository {
  public constructor(private readonly pool: Pool) {}

  public async findByDriverId(driverId: string): Promise<DriverConnectAccountRecord | null> {
    const result = await this.pool.query<Row>(`select ${COLUMNS} from driver_connect_accounts where driver_id = $1`, [driverId])
    const row = result.rows[0]
    return row === undefined ? null : map(row)
  }

  public async insertIfAbsent(input: { driverId: string; stripeAccountId: string; entityType: DriverEntityType; livemode: boolean }): Promise<void> {
    await this.pool.query(
      `insert into driver_connect_accounts (driver_id, stripe_account_id, entity_type, livemode)
       values ($1, $2, $3, $4) on conflict (driver_id) do nothing`,
      [input.driverId, input.stripeAccountId, input.entityType, input.livemode]
    )
  }

  /**
   * `restricted_at` : posé quand un compte JUSQU'ICI actif devient restreint (transferts `restricted`, exigences
   * `past_due`/`disabled`) ; effacé dès que Stripe le donne à nouveau actif et sans exigence bloquante (régularisation,
   * D-F). Un compte jamais onboardé n'est pas « restreint » : il est simplement non prêt.
   */
  public async updateStatus(driverId: string, status: { transfers: CapabilityState; payouts: CapabilityState; requirements: RequirementsState }): Promise<DriverConnectAccountRecord | null> {
    const result = await this.pool.query<Row>(
      `update driver_connect_accounts set
         restricted_at = case
           when transfers_status = 'active' and ($2::text = 'restricted' or $4::text in ('past_due', 'disabled')) then coalesce(restricted_at, now())
           when $2::text = 'active' and $4::text not in ('past_due', 'disabled') then null
           else restricted_at end,
         transfers_status = $2, payouts_status = $3, requirements_state = $4, last_synced_at = now(), updated_at = now()
       where driver_id = $1
       returning ${COLUMNS}`,
      [driverId, status.transfers, status.payouts, status.requirements]
    )
    const row = result.rows[0]
    return row === undefined ? null : map(row)
  }

  public async findDriverIdByAccountId(accountId: string): Promise<string | null> {
    const result = await this.pool.query<{ driver_id: string }>('select driver_id from driver_connect_accounts where stripe_account_id = $1', [accountId])
    return result.rows[0]?.driver_id ?? null
  }
}
