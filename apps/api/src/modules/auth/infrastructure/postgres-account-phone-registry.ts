import type { PoolClient } from 'pg'
import type { AccountPhoneRegistry } from '../ports/account-phone-registry.js'

export class PostgresAccountPhoneRegistry implements AccountPhoneRegistry {
  public async reserve(client: PoolClient, accountId: string, role: 'driver' | 'merchant', phoneE164: string): Promise<void> {
    await client.query('insert into account_phone_registry (account_id, role, phone_e164) values ($1, $2, $3)', [accountId, role, phoneE164])
  }
  public async release(client: PoolClient, accountId: string): Promise<void> {
    await client.query('delete from account_phone_registry where account_id = $1 and role = \'driver\'', [accountId])
  }
}
