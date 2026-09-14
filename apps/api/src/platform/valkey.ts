import { createRequire } from 'node:module'
import type Redis from 'ioredis'
import { config } from './config.js'

// ioredis (MIT) is compatible with the Valkey 8.x protocol used by the API.
const require = createRequire(import.meta.url)
type RedisConstructor = new (url: string) => Redis

function missingClient(): Redis {
  const unavailable = async (): Promise<never> => { throw new Error('ioredis is not installed') }
  return { set: unavailable, get: unavailable, expire: unavailable, quit: async () => 'OK' } as unknown as Redis
}

let RedisClient: RedisConstructor | undefined
try {
  RedisClient = require('ioredis').default as RedisConstructor
} catch {
  // This only keeps isolated unit tests runnable when dependencies were not installed.
  // API startup in a deployed environment must install the declared ioredis dependency.
}

export const valkey: Redis = RedisClient === undefined ? missingClient() : new RedisClient(config.VALKEY_URL)
