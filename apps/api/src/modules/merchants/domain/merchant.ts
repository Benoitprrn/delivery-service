export type Merchant = {
  id: string
  name: string
  zoneId: string | null
  address: string | null
  phonePrimary: string | null
  phoneSecondary: string | null
  logoUrl: string | null
  lat: number | null
  lng: number | null
  onboardingCompleted: boolean
  serviceFeeRateBpsOverride?: number | null
}

export type MerchantAccountContact = { firstName: string; lastName: string; phone: string }

export function isMerchantInformationComplete(merchant: Merchant): boolean {
  return merchant.name.trim() !== '' && merchant.address !== null && merchant.address.trim() !== '' && merchant.lat !== null && merchant.lng !== null && merchant.zoneId !== null && merchant.phonePrimary !== null && merchant.phonePrimary.trim() !== ''
}
