import type { Pool } from 'pg'
import { derivePayoutReadiness } from '../domain/driver-account.js'

type AccountRow = { driver_id: string; transfers_status: string; payouts_status: string; requirements_state: string; restricted_at: Date | null }

/**
 * Éligibilité D-F : un livreur est prêt UNIQUEMENT s'il a un compte Connect local dont les capacités de transfert sont
 * actives, sans exigence Stripe bloquante et sans restriction enregistrée. Fail-closed : compte absent, statut
 * inconnu ou restriction = non prêt (les gains acquis restent dus, mais aucune nouvelle course). L'état local est
 * synchronisé depuis Stripe (R30) ; le pay-run relit aussi l'état avant chaque Transfer.
 */
export class PostgresDriverPayoutReadinessReader {
  public constructor(private readonly pool: Pool) {}

  public async findReadyDriverIds(driverIds: readonly string[]): Promise<Set<string>> {
    if (driverIds.length === 0) return new Set()
    const result = await this.pool.query<AccountRow>(
      'select driver_id, transfers_status, payouts_status, requirements_state, restricted_at from driver_connect_accounts where driver_id = any($1::uuid[])',
      [driverIds]
    )
    const ready = new Set<string>()
    for (const row of result.rows) {
      const readiness = derivePayoutReadiness({ transfersStatus: row.transfers_status, requirementsState: row.requirements_state, payoutsStatus: row.payouts_status })
      if (readiness === 'ready' && row.restricted_at === null) ready.add(row.driver_id)
    }
    return ready
  }

  public async isReady(driverId: string): Promise<boolean> {
    return (await this.findReadyDriverIds([driverId])).has(driverId)
  }
}
