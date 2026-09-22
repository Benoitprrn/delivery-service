import { createHmac } from 'node:crypto'

export const CONNECT_SECRET = 'whsec_connect_local_test'
export const THIN_SECRET = 'whsec_thin_local_test'

/** En-tête `Stripe-Signature` calculé localement : `t=<ts>,v1=HMAC-SHA256(secret, "<ts>.<corps brut>")`. */
export function sign(payload: string, secret = CONNECT_SECRET, timestampSeconds = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac('sha256', secret).update(`${timestampSeconds}.${payload}`).digest('hex')
  return `t=${timestampSeconds},v1=${digest}`
}

export type SnapshotOptions = {
  id: string
  type: string
  account?: string | null
  object: Record<string, unknown>
}

/** Événement snapshot (v1) tel que Stripe l'envoie sur un endpoint Connect. */
export function snapshotEvent(options: SnapshotOptions): string {
  return JSON.stringify({
    id: options.id,
    object: 'event',
    api_version: '2026-08-26.dahlia',
    created: 1_790_000_000,
    livemode: false,
    type: options.type,
    ...(options.account === null ? {} : { account: options.account ?? 'acct_restaurant_a' }),
    data: { object: options.object }
  })
}

export function paymentIntentEvent(id: string, type: string, paymentIntentId: string, account = 'acct_restaurant_a', metadata: Record<string, string> = {}): string {
  return snapshotEvent({
    id,
    type,
    account,
    object: { id: paymentIntentId, object: 'payment_intent', status: 'succeeded', amount: 5000, currency: 'eur', metadata }
  })
}

/** Notification mince (v2) : uniquement des références, jamais l'objet. */
export function thinEvent(id: string, type: string, accountId: string): string {
  return JSON.stringify({
    id,
    object: 'v2.core.event',
    type,
    livemode: false,
    created: '2026-09-20T10:00:00.000Z',
    related_object: { id: accountId, type: 'v2.core.account', url: `/v2/core/accounts/${accountId}` }
  })
}
