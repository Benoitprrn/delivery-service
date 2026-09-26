import type { PoolClient } from 'pg'

/** Cross-role account identity phone reservation. Auth owns this table. */
export interface AccountPhoneRegistry {
  reserve(client: PoolClient, accountId: string, role: 'driver' | 'merchant', phoneE164: string): Promise<void>
  release(client: PoolClient, accountId: string): Promise<void>
}
