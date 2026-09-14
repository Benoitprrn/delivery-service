import type { Merchant } from '../domain/merchant.js'

export type MerchantPatch = {
  name: string
  phone: string
  address: string
  lat: number
  lng: number
}

export interface MerchantRepository {
  findById(id: string): Promise<Merchant | null>
  update(id: string, patch: MerchantPatch): Promise<Merchant>
}
