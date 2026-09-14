import { afterAll } from 'vitest'
import { pool } from '../src/platform/db.js'

afterAll(async () => {
  await pool.end()
})
