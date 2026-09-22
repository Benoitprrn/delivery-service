import type { CapabilityStatus } from './connect-payments-provider.js'
export type MerchantConnect = { merchantId: string; merchantConfiguredAt: Date | null; cardPaymentsStatus: CapabilityStatus; cartesBancairesStatus: CapabilityStatus; requirementsCount: number; lastSyncedAt: Date | null }
export interface MerchantConnectRepository { findByMerchantId(merchantId: string): Promise<MerchantConnect | null>; save(value: MerchantConnect): Promise<MerchantConnect> }
