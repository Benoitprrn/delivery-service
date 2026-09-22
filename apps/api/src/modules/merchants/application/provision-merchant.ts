import { randomUUID } from 'node:crypto'
import type { AuthAdmin } from '../../auth/public.js'
import { MerchantProvisioningError } from '../domain/errors.js'
import type { MerchantRepository } from '../ports/merchant-repository.js'

type ErrorLogger = { error: (obj: object, message?: string) => void }

export type ProvisionMerchantCommand = {
  merchantName: string
  email: string
  password: string
  correlationId: string
  logger: ErrorLogger
}

export class ProvisionMerchantUseCase {
  public constructor(private readonly merchants: MerchantRepository, private readonly authAdmin: AuthAdmin) {}

  public async execute(command: ProvisionMerchantCommand): Promise<{ merchantId: string; onboardingCompleted: false }> {
    const merchantId = randomUUID()
    await this.authAdmin.createUser({ id: merchantId, email: command.email, password: command.password, appMetadata: { role: 'merchant' } })
    try {
      await this.merchants.createIncomplete(merchantId, command.merchantName)
    } catch {
      try {
        await this.authAdmin.deleteUser(merchantId)
      } catch (compensationError) {
        command.logger.error({ err: compensationError, correlationId: command.correlationId, authUserId: merchantId }, 'Failed to compensate orphaned Supabase Auth user')
      }
      throw new MerchantProvisioningError('Merchant profile provisioning failed')
    }
    return { merchantId, onboardingCompleted: false }
  }
}
