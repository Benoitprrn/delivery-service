import type { DirectoryResolution } from './directory-selection.js'

export type TransmissionReadiness =
  | { status: 'ready' }
  | { status: 'missing_seller_electronic_address' }
  | { status: 'waiting_for_mandate' }
  | { status: 'waiting_for_recipient_address' }
  | { status: 'invalid_recipient_configuration' }

export function canSubmitElectronicInvoice(input: { issuerKind: 'driver' | 'locadely'; sellerElectronicAddressPresent: boolean; driverMandateVerified: boolean; buyerDirectory: DirectoryResolution }): TransmissionReadiness {
  // The mapper currently always falls back to configured seller data, but this remains a defensive transmission guard.
  if (!input.sellerElectronicAddressPresent) return { status: 'missing_seller_electronic_address' }
  if (input.issuerKind === 'driver' && !input.driverMandateVerified) return { status: 'waiting_for_mandate' }
  if (input.buyerDirectory.status === 'ready') return { status: 'ready' }
  if (input.buyerDirectory.status === 'ambiguous') return { status: 'invalid_recipient_configuration' }
  return { status: 'waiting_for_recipient_address' }
}
