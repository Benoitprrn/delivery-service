import { derivePayoutReadiness } from '../domain/driver-account.js'
import type { DriverConnectProvider } from '../ports/driver-connect-provider.js'
import type { DriverAccountLiveReader } from '../ports/driver-payout.js'

/** Relit chez Stripe l'état du compte du livreur juste avant de le payer : `stripe_transfers` actif et aucune exigence bloquante (D-F). */
export class ProviderDriverAccountLiveReader implements DriverAccountLiveReader {
  public constructor(private readonly provider: Pick<DriverConnectProvider, 'getAccountStatus'>) {}

  public async isTransferReady(stripeAccountId: string): Promise<boolean> {
    const status = await this.provider.getAccountStatus(stripeAccountId)
    return derivePayoutReadiness({ transfersStatus: status.transfers, requirementsState: status.requirements, payoutsStatus: status.payouts }) === 'ready'
  }
}
