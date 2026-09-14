import pino, { type LoggerOptions } from 'pino'
import { config } from './config.js'

// Retourne des OPTIONS plutôt qu'une instance Pino construite : Fastify sait
// instancier son logger interne lui-même à partir d'options (Fastify({ logger })),
// ce qui évite un conflit de type entre `pino.Logger` et `FastifyBaseLogger`
// sous exactOptionalPropertyTypes (constaté avec loggerInstance à l'étape 1).
// `logger` (instance autonome, ci-dessous) reste utile hors Fastify : futurs
// scripts, worker outbox (étape 7), etc.
export function createLoggerOptions(): LoggerOptions {
  const level = config.NODE_ENV === 'production' ? 'info' : 'debug'

  if (config.NODE_ENV !== 'development') {
    return { level }
  }

  return {
    level,
    transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
  }
}

export const logger = pino(createLoggerOptions())
