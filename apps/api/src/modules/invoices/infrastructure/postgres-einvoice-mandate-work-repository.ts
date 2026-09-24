import type { Pool } from 'pg'
import { inTransaction } from '../../../platform/transaction.js'
import type { EInvoiceMandateVerificationRepository, EInvoiceMandateWorkRepository, MandateSubmissionWork } from '../ports/einvoice-mandate-work-repository.js'

type ClaimedRow = { id: string; driver_id: string; grantor_siren: string; grantor_legal_name_snapshot: string; signed_pdf_storage_path: string; attempts: number }

export class PostgresEInvoiceMandateWorkRepository implements EInvoiceMandateWorkRepository, EInvoiceMandateVerificationRepository {
  public constructor(private readonly pool: Pool) {}

  public async claimDue(now: Date, leaseSeconds: number, limit: number): Promise<MandateSubmissionWork[]> {
    const rows = await inTransaction(this.pool, async (client) => (await client.query<ClaimedRow>(
      `update driver_einvoice_mandates
       set submission_status = 'submitting', locked_until = $2, attempts = attempts + 1, last_attempt_at = $1
       where id in (
         select id from driver_einvoice_mandates
         where revoked_at is null and (
           (submission_status in ('prepared', 'retryable') and (next_attempt_at is null or next_attempt_at <= $1))
           or (submission_status = 'submitting' and locked_until < $1)
         )
         order by accepted_at asc, id asc
         limit $3
         for update skip locked
       )
       returning id, driver_id, grantor_siren, grantor_legal_name_snapshot, signed_pdf_storage_path, attempts`,
      [now, new Date(now.getTime() + leaseSeconds * 1_000), limit]
    )).rows)
    return rows.map((row) => ({ id: row.id, driverId: row.driver_id, grantorSiren: row.grantor_siren, grantorLegalName: row.grantor_legal_name_snapshot, signedPdfStoragePath: row.signed_pdf_storage_path, attempts: row.attempts }))
  }

  public async submitted(input: { id: string; providerMandateId: string; now: Date }): Promise<void> { await this.pool.query(
    `update driver_einvoice_mandates set submission_status = 'submitted', provider_mandate_id = $2, submitted_at = $3,
       provider_verification_status = case when provider_verification_status = 'not_submitted' then 'submitted' else provider_verification_status end,
       locked_until = null, next_attempt_at = null, last_error = null where id = $1 and submission_status = 'submitting'`, [input.id, input.providerMandateId, input.now]) }
  public async retryable(input: { id: string; error: string; retryAt: Date; now: Date }): Promise<void> { await this.pool.query(
    `update driver_einvoice_mandates set submission_status = 'retryable', last_error = $2, next_attempt_at = $3, locked_until = null where id = $1 and submission_status = 'submitting'`, [input.id, input.error, input.retryAt]) }
  public async failed(input: { id: string; error: string; now: Date }): Promise<void> { await this.pool.query(
    `update driver_einvoice_mandates set submission_status = 'failed', last_error = $2, locked_until = null, next_attempt_at = null where id = $1 and submission_status = 'submitting'`, [input.id, input.error]) }
  public async unknownOutcome(input: { id: string; error: string; now: Date }): Promise<void> { await this.pool.query(
    `update driver_einvoice_mandates set submission_status = 'unknown_outcome', last_error = $2, locked_until = null, next_attempt_at = null where id = $1 and submission_status = 'submitting'`, [input.id, input.error]) }

  public async dueForVerification(_now: Date, limit: number): Promise<Array<{ id: string; providerMandateId: string }>> { return (await this.pool.query<{ id: string; provider_mandate_id: string }>(
    `select id, provider_mandate_id from driver_einvoice_mandates where revoked_at is null and provider_mandate_id is not null and provider_verification_status in ('submitted', 'not_verified') order by last_checked_at asc nulls first, id asc limit $1`, [limit]
  )).rows.map((row) => ({ id: row.id, providerMandateId: row.provider_mandate_id })) }
  public async applyVerification(input: { id: string; verificationStatus: 'verified' | 'not_verified'; now: Date }): Promise<void> {
    if (input.verificationStatus === 'verified') await this.pool.query(`update driver_einvoice_mandates set last_checked_at = $2, provider_verification_status = 'verified', verified_at = case when provider_verification_status = 'verified' then verified_at else $2 end where id = $1`, [input.id, input.now])
    else await this.pool.query(`update driver_einvoice_mandates set last_checked_at = $2, provider_verification_status = 'not_verified' where id = $1`, [input.id, input.now])
  }
}
