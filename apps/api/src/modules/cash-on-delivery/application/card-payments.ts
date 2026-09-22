import type { PaymentsLogger, PaymentsModule } from '../../payments/public.js'
import type {
  CapabilityStatus,
  ConnectAccountStatus,
  ConnectPaymentsProvider
} from '../ports/connect-payments-provider.js'
import type { MerchantConnectRepository } from '../ports/merchant-connect-repository.js'

export type CardPaymentsState =
  | 'not_configured'
  | 'action_required'
  | 'pending_review'
  | 'ready'
  | 'restricted'

export type CardPaymentsStatus = {
  state: CardPaymentsState
  cardPaymentsReady: boolean
  cartesBancairesStatus: CapabilityStatus
  requirementsCount: number
}

/**
 * Seul couplage avec le module payments : son `public.ts`. `payments` reste
 * propriétaire de l'Account v2 (création sérialisée/idempotente et synchro
 * d'identité, qui doit précéder l'ajout de `merchant`).
 */
export type CardPaymentsAccountPort = Pick<
  PaymentsModule,
  'getMerchantStripeAccountId' | 'ensureMerchantStripeAccount'
>

export type CardPaymentsOnboardingUrls = {
  returnUrl: string
  refreshUrl: string
}

export type CardPaymentsDependencies = {
  logger?: Pick<PaymentsLogger, 'warn'>
  now?: () => Date
}

const NOT_CONFIGURED: CardPaymentsStatus = {
  state: 'not_configured',
  cardPaymentsReady: false,
  cartesBancairesStatus: 'not_requested',
  requirementsCount: 0
}

/**
 * Traduit l'état Stripe (capabilities `card_payments` / `cartes_bancaires_payments`)
 * en état produit. Seule `card_payments = active` autorise le paiement carte.
 */
export function deriveCardPaymentsStatus(status: ConnectAccountStatus): CardPaymentsStatus {
  if (!status.merchantConfigured) {
    return { ...NOT_CONFIGURED }
  }

  const common = {
    cartesBancairesStatus: status.cartesBancaires,
    requirementsCount: status.requirementsCount
  }

  if (status.cardPayments === 'active') {
    return { state: 'ready', cardPaymentsReady: true, ...common }
  }
  if (status.cardPayments === 'pending') {
    return { state: 'pending_review', cardPaymentsReady: false, ...common }
  }
  if (status.requirementsCount > 0) {
    return { state: 'action_required', cardPaymentsReady: false, ...common }
  }
  return { state: 'restricted', cardPaymentsReady: false, ...common }
}

export class CardPaymentsUseCases {
  /** Évite deux `addMerchantConfiguration` simultanés pour un même Account (dans ce processus). */
  private readonly merchantConfigurations = new Map<string, Promise<ConnectAccountStatus>>()
  private readonly logger: Pick<PaymentsLogger, 'warn'>
  private readonly now: () => Date

  constructor(
    private readonly payments: CardPaymentsAccountPort,
    private readonly provider: ConnectPaymentsProvider,
    private readonly connects: MerchantConnectRepository,
    private readonly onboardingUrls: CardPaymentsOnboardingUrls,
    dependencies: CardPaymentsDependencies = {}
  ) {
    this.logger = dependencies.logger ?? { warn: () => undefined }
    this.now = dependencies.now ?? (() => new Date())
  }

  /** État courant, relu chez Stripe (source de vérité) puis mis en cache local. */
  async getStatus(merchantId: string): Promise<CardPaymentsStatus> {
    const accountId = await this.payments.getMerchantStripeAccountId(merchantId)
    if (accountId === null) {
      return { ...NOT_CONFIGURED }
    }

    const status = await this.provider.getAccountStatus(accountId)
    await this.storeStatus(merchantId, status)
    return deriveCardPaymentsStatus(status)
  }

  /**
   * Garde de création de commande COD. Échoue fermé : Stripe indisponible ou
   * erreur technique valent « non prêt » (jamais de COD sans preuve d'activation).
   */
  async isReady(merchantId: string): Promise<boolean> {
    try {
      return (await this.getStatus(merchantId)).cardPaymentsReady
    } catch (error) {
      this.logger.warn(
        {
          merchantId,
          errorClass: error instanceof Error ? error.constructor.name : 'UnknownError'
        },
        'Card payments readiness check failed; treating as not ready'
      )
      return false
    }
  }

  /**
   * Opt-in du restaurant. Ordre imposé :
   *  1. l'Account v2 existe (création + synchro d'identité tant que `merchant`
   *     est absent) : après `merchant`, la France exige un account token ;
   *  2. la configuration `merchant` est ajoutée une seule fois ;
   *  3. seulement ensuite, le lien d'onboarding hébergé ['customer', 'merchant'].
   */
  async createOnboardingLink(
    merchantId: string,
    email: string | undefined
  ): Promise<{ url: string; expiresAt: Date }> {
    const account = await this.payments.ensureMerchantStripeAccount(merchantId, email)
    const status = await this.ensureMerchantConfigured(account.stripeAccountId)
    await this.storeStatus(merchantId, status)

    return this.provider.createOnboardingLink({
      accountId: account.stripeAccountId,
      ...this.onboardingUrls
    })
  }

  private ensureMerchantConfigured(accountId: string): Promise<ConnectAccountStatus> {
    const inFlight = this.merchantConfigurations.get(accountId)
    if (inFlight !== undefined) {
      return inFlight
    }

    const operation = this.configureMerchant(accountId).finally(() => {
      this.merchantConfigurations.delete(accountId)
    })
    this.merchantConfigurations.set(accountId, operation)
    return operation
  }

  private async configureMerchant(accountId: string): Promise<ConnectAccountStatus> {
    const current = await this.provider.getAccountStatus(accountId)
    if (current.merchantConfigured) {
      return current
    }

    await this.provider.addMerchantConfiguration({ accountId })
    return this.provider.getAccountStatus(accountId)
  }

  /** Cache local dérivé uniquement : aucun identifiant d'identité/KYC Stripe n'est conservé. */
  private async storeStatus(merchantId: string, status: ConnectAccountStatus): Promise<void> {
    const now = this.now()
    let merchantConfiguredAt: Date | null = null
    if (status.merchantConfigured) {
      const existing = await this.connects.findByMerchantId(merchantId)
      merchantConfiguredAt = existing?.merchantConfiguredAt ?? now
    }

    await this.connects.save({
      merchantId,
      merchantConfiguredAt,
      cardPaymentsStatus: status.cardPayments,
      cartesBancairesStatus: status.cartesBancaires,
      requirementsCount: status.requirementsCount,
      lastSyncedAt: now
    })
  }
}
