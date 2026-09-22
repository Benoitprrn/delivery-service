export type SepaPaymentStatus = 'setup_pending' | 'active' | 'invalid' | 'detach_pending' | 'detached'

export const MAX_WEBHOOK_ATTEMPTS = 20
export const MAX_DETACH_ATTEMPTS = 20
export const WEBHOOK_LEASE_MINUTES = 5
export const DETACH_LEASE_MINUTES = 5

export type MerchantPaymentMethod = {
  id: string
  merchantId: string
  setupIntentId: string
  stripePaymentMethodId: string | null
  stripeMandateId: string | null
  status: SepaPaymentStatus
  bankName: string | null
  last4: string | null
  country: string | null
  mandateReference: string | null
  activatedAt: Date | null
  invalidatedAt: Date | null
}

export type MerchantPaymentProfile = { merchantId: string; stripeAccountId: string }
export type ActivePaymentMethod = MerchantPaymentMethod & { status: 'active' }
export type WebhookEventClaim = { outcome: 'claimed'; token: string } | { outcome: 'processed' | 'in_progress' }
export type StoredStripeWebhookEvent = { eventId: string; eventType: string; objectId: string; merchantId: string | null; objectStatus: string | null }
export type ClaimedStripeWebhookEvent = { event: StoredStripeWebhookEvent; token: string }
export type DetachClaim = { paymentMethodId: string; token: string }
export type WebhookFailure = { eventId: string; token: string; errorClass: string }
export type DetachFailure = { paymentMethodId: string; token: string; errorClass: string }

export interface PaymentRepository {
  findProfile(merchantId: string): Promise<MerchantPaymentProfile | null>
  saveProfile(profile: MerchantPaymentProfile): Promise<MerchantPaymentProfile>
  findActive(merchantId: string): Promise<ActivePaymentMethod | null>
  findDisplayMethod(merchantId: string): Promise<MerchantPaymentMethod | null>
  findPending(merchantId: string): Promise<MerchantPaymentMethod | null>
  findBySetupIntent(setupIntentId: string): Promise<MerchantPaymentMethod | null>
  createPending(merchantId: string, setupIntentId: string): Promise<MerchantPaymentMethod>
  invalidatePending(setupIntentId: string): Promise<void>
  activate(setupIntentId: string, details: Omit<MerchantPaymentMethod, 'id' | 'merchantId' | 'setupIntentId' | 'status' | 'activatedAt' | 'invalidatedAt'>): Promise<{ active: ActivePaymentMethod; previous: ActivePaymentMethod | null }>
  markDetached(paymentMethodId: string): Promise<void>
  markMandateInactive(mandateId: string): Promise<void>
  claimDetachPending(limit: number): Promise<DetachClaim[]>
  recordDetachFailure(failure: DetachFailure): Promise<boolean>
  recordWebhookEvent(event: StoredStripeWebhookEvent): Promise<void>
  claimNextWebhookEvent(): Promise<ClaimedStripeWebhookEvent | null>
  completeWebhookEvent(eventId: string, token: string): Promise<boolean>
  failWebhookEvent(failure: WebhookFailure): Promise<boolean>
}
