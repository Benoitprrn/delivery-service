import Stripe from 'stripe'
import type { Pool } from 'pg'
import { ProcessConnectWebhooksUseCase, ReceiveConnectWebhookUseCase } from './application/connect-webhook.js'
import { PostgresConnectWebhookRepository } from './infrastructure/postgres-connect-webhook-repository.js'
import {
  StripeConnectWebhookVerifier,
  UnavailableConnectWebhookVerifier
} from './infrastructure/stripe-connect-webhook-verifier.js'
import {
  ConnectReconcilerNotWiredError,
  type ConnectWebhookDomainPorts,
  type ConnectWebhookVerifier
} from './ports/connect-webhook.js'
import { noopPaymentsLogger, type PaymentsLogger } from './ports/payments-logger.js'
import { registerStripeConnectWebhookRoute } from './transport/http/connect-webhook-routes.js'

/**
 * Réconciliateur par défaut tant que le worker de réconciliation COD n'est pas
 * branché : il échoue toujours. L'événement reste donc rejouable (backoff, puis
 * dead-letter visible) et n'est jamais marqué traité sans réconciliation réelle.
 */
export const reconcilerNotWired: ConnectWebhookDomainPorts['reconcilePaymentIntent'] = async () => {
  throw new ConnectReconcilerNotWiredError('PaymentIntent reconciliation is not wired')
}

export type StripeConnectWebhookModule = {
  /** `true` seulement si Stripe est actif ET qu'un secret Connect est présent. */
  enabled: boolean
  receiveWebhook: (payload: string | Buffer, signature: string) => Promise<void>
  processBatch: () => Promise<number>
}

export type StripeConnectWebhookOptions = {
  paymentsEnabled: boolean
  secretKey: string | undefined
  /** Un ou plusieurs secrets `whsec_…` séparés par des virgules (une destination Stripe = un secret). */
  webhookSecret: string | undefined
  domain: ConnectWebhookDomainPorts
}

export function parseConnectWebhookSecrets(value: string | undefined): string[] {
  return (value ?? '').split(',').map((secret) => secret.trim()).filter((secret) => secret !== '')
}

export function createStripeConnectWebhookModule(
  pool: Pool,
  options: StripeConnectWebhookOptions,
  logger: PaymentsLogger = noopPaymentsLogger,
  verifierOverride?: ConnectWebhookVerifier
): StripeConnectWebhookModule {
  const secrets = parseConnectWebhookSecrets(options.webhookSecret)
  const enabled = options.paymentsEnabled && options.secretKey !== undefined && secrets.length > 0
  const repository = new PostgresConnectWebhookRepository(pool)
  const verifier = verifierOverride ?? (enabled && options.secretKey !== undefined
    ? new StripeConnectWebhookVerifier(new Stripe(options.secretKey, { maxNetworkRetries: 0 }), secrets)
    : new UnavailableConnectWebhookVerifier())
  const receive = new ReceiveConnectWebhookUseCase(verifier, repository, logger)
  const process = new ProcessConnectWebhooksUseCase(repository, options.domain, logger)

  return {
    enabled,
    receiveWebhook: receive.receive.bind(receive),
    processBatch: process.processBatch.bind(process)
  }
}

export function startStripeConnectWebhookWorker(
  processBatch: () => Promise<unknown>,
  logger: PaymentsLogger = noopPaymentsLogger,
  intervalMs = 2_000
): () => void {
  let processing = false
  const run = async (): Promise<void> => {
    if (processing) return
    processing = true
    try {
      await processBatch()
    } catch (error) {
      const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError'
      logger.error({ errorClass }, 'Stripe Connect webhook worker cycle failed')
    } finally {
      processing = false
    }
  }
  void run()
  const interval = setInterval(() => { void run() }, intervalMs)
  interval.unref()
  return () => clearInterval(interval)
}

export { registerStripeConnectWebhookRoute }
export type { ConnectWebhookDomainPorts } from './ports/connect-webhook.js'
