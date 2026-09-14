import { Pool } from 'pg'
import { config } from './config.js'

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  statement_timeout: 5_000,
  idle_in_transaction_session_timeout: 5_000
})
