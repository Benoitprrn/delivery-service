import { PgBoss } from 'pg-boss'
import { config } from './config.js'

export const pgBoss = new PgBoss(config.PGBOSS_DATABASE_URL)

export async function startPgBoss(): Promise<void> {
  await pgBoss.start()
}

export async function stopPgBoss(): Promise<void> {
  await pgBoss.stop()
}
