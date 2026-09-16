import type { Merchant } from '../domain/merchant.js'

export type MerchantPatch = {
  name: string
  phoneLandline: string | null
  phoneMobile: string | null
  logoUrl: string | null
  address: string
  lat: number
  lng: number
}

export interface MerchantRepository {
  findById(id: string): Promise<Merchant | null>
  update(id: string, patch: MerchantPatch): Promise<Merchant>
  updateLogoUrl(id: string, logoUrl: string): Promise<Merchant>
}
