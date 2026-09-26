import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { AccountAlreadyExistsError, AuthProviderError, AuthProviderUnknownOutcomeError, type AccountPhoneRegistry, type AuthAdmin, type AuthUserLookup } from '../../auth/public.js'
import { inTransaction } from '../../../platform/transaction.js'
import { DriverProvisioningError, DriverSignupConflictError, DriverSignupFinalizingError } from '../domain/driver-signup-errors.js'

type DriverLocalWriter = {
  insertSignup(client: PoolClient, input: { id: string; firstName: string; lastName: string; phone: string; zoneId: string }): Promise<void>
  deleteSignup(client: PoolClient, id: string): Promise<void>
  recordTermsAcceptance(client: PoolClient, driverId: string): Promise<void>
}
type ErrorLogger = { error: (obj: object, message?: string) => void }
export type ProvisionDriverCommand = { firstName: string; lastName: string; email: string; phone: string; password: string; correlationId: string; logger: ErrorLogger }

export class ProvisionDriverUseCase {
  public constructor(private readonly pool: Pool, private readonly drivers: DriverLocalWriter, private readonly phones: AccountPhoneRegistry, private readonly auth: AuthAdmin & AuthUserLookup, private readonly zoneId: string) {}
  public async execute(command: ProvisionDriverCommand): Promise<{ driverId: string }> {
    const driverId = randomUUID()
    try {
      await inTransaction(this.pool, async (client) => {
        await this.phones.reserve(client, driverId, 'driver', command.phone)
        await this.drivers.insertSignup(client, { id: driverId, firstName: command.firstName, lastName: command.lastName, phone: command.phone, zoneId: this.zoneId })
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw new DriverSignupConflictError()
      throw error
    }
    try {
      await this.auth.createUser({ id: driverId, email: command.email, password: command.password, appMetadata: { role: 'driver' } })
      await this.finalizeTermsAcceptance(driverId, command)
      return { driverId }
    } catch (error) {
      if (error instanceof AuthProviderUnknownOutcomeError) {
        // Only a lookup failure is genuinely inconclusive — we cannot prove
        // either outcome, so the reservation must be parked, never guessed at.
        // A CONFIRMED negative (lookup succeeded, no user found) falls through
        // to the shared compensation below — it is treated exactly like any
        // other Auth failure (compensated, retryable), never parked as if
        // still undecided.
        try {
          if (await this.auth.getUserEmail(driverId) !== null) {
            await this.finalizeTermsAcceptance(driverId, command)
            return { driverId }
          }
        } catch (lookupError) {
          await this.recordUnknownOutcome(driverId, command, lookupError)
          throw new DriverSignupFinalizingError()
        }
      }
      const conflict = error instanceof AccountAlreadyExistsError
      // No driver_terms_acceptances row exists yet at this point (it is only
      // written after Auth is confirmed, above) — the append-only trigger on
      // that table can never block this compensation.
      try { await inTransaction(this.pool, async (client) => { await this.drivers.deleteSignup(client, driverId); await this.phones.release(client, driverId) }) } catch (compensationError) {
        await this.recordUnknownOutcome(driverId, command, compensationError)
        throw new DriverSignupFinalizingError()
      }
      if (conflict) throw new DriverSignupConflictError()
      if (error instanceof AuthProviderError) throw new DriverProvisioningError()
      throw error
    }
  }
  // Written only once Auth is confirmed: the row is then genuinely final
  // (never deleted), matching driver_terms_acceptances' append-only contract.
  // A failure here does not roll back an already-real account; it is logged
  // and left for the same manual reconciliation channel as an unknown Auth
  // outcome, since the account itself is legitimate either way.
  private async finalizeTermsAcceptance(driverId: string, command: ProvisionDriverCommand): Promise<void> {
    try {
      await inTransaction(this.pool, async (client) => { await this.drivers.recordTermsAcceptance(client, driverId) })
    } catch (error) {
      await this.recordUnknownOutcome(driverId, command, error)
    }
  }
  private async recordUnknownOutcome(driverId: string, command: ProvisionDriverCommand, error: unknown): Promise<void> {
    // No worker currently consumes driver.signup.reconcile.v1 — this row is a
    // manual-ops dead letter today, not an automated retry. The log line is
    // the only immediate signal that a driver signup is stuck pending review.
    command.logger.error({ err: error, driverId, correlationId: command.correlationId }, 'Driver signup outcome is unknown; local reservation kept pending manual reconciliation')
    try {
      await this.pool.query(`insert into outbox_event (event_type, aggregate_type, aggregate_id, aggregate_version, payload, correlation_id)
        values ('driver.signup.reconcile.v1', 'driver', $1, 0, $2::jsonb, $3) on conflict do nothing`, [driverId, JSON.stringify({ driverId, email: command.email, reason: error instanceof Error ? error.name : 'unknown' }), command.correlationId])
    } catch (outboxError) { command.logger.error({ err: outboxError, driverId }, 'Failed to persist driver signup reconciliation event') }
  }
}
function isUniqueViolation(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505' }
