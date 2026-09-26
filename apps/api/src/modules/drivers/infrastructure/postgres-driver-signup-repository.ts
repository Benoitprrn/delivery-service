import type { PoolClient } from 'pg'

export class PostgresDriverSignupRepository {
  public async insertSignup(client: PoolClient, input: { id: string; firstName: string; lastName: string; phone: string; zoneId: string }): Promise<void> {
    await client.query('insert into drivers (id, name, first_name, last_name, phone, zone_id, is_available) values ($1, $2, $3, $4, $5, $6, false)', [input.id, `${input.firstName} ${input.lastName}`, input.firstName, input.lastName, input.phone, input.zoneId])
  }
  // Only called once Supabase Auth is confirmed for this driver — before that,
  // no row exists here, so compensation (deleteSignup) never has to fight the
  // append-only trigger on this table.
  public async recordTermsAcceptance(client: PoolClient, driverId: string): Promise<void> {
    await client.query(`insert into driver_terms_acceptances (driver_id, version, content_hash) values ($1, 'signup-checkbox-v1-placeholder', 'sha256:PLACEHOLDER_REPLACE_WITH_APPROVED_TERMS_CONTENT')`, [driverId])
  }
  public async deleteSignup(client: PoolClient, id: string): Promise<void> {
    await client.query('delete from drivers where id = $1', [id])
  }
}
