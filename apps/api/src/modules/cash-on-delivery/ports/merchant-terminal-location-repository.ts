export type MerchantTerminalLocation = { merchantId: string; stripeAccountId: string; terminalLocationId: string }
export interface MerchantTerminalLocationRepository { findByMerchantId(merchantId: string): Promise<MerchantTerminalLocation | null>; save(location: MerchantTerminalLocation): Promise<MerchantTerminalLocation> }
