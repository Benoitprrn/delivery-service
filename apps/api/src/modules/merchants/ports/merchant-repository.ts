import type { Merchant } from '../domain/merchant.js'
import type { PostalAddress } from './sirene-provider.js'
import type { PoolClient } from 'pg'

export type MerchantInformationPatch = {
  name: string
  address: string
  lat: number
  lng: number
  zoneId: string
  phonePrimary: string
  phoneSecondary: string | null
}

export interface MerchantRepository {
  findById(id: string, client?: PoolClient): Promise<Merchant | null>
  createIncomplete(id: string, name: string): Promise<void>
  updateInformation(id: string, patch: MerchantInformationPatch, client?: PoolClient): Promise<Merchant>
  updateLogoUrl(id: string, logoUrl: string): Promise<Merchant>
}

export type SireneVerificationStatus = 'verified' | 'unavailable' | 'restricted' | 'unverified'
export type MerchantLegalInformation = { merchantId: string; siret: string; siren: string; legalName: string; legalAddress: PostalAddress; billingAddress: PostalAddress | null; vatNumber: string | null; sireneVerificationStatus: SireneVerificationStatus; sireneVerifiedAt: Date | null }
export type MerchantLegalInformationPatch = Omit<MerchantLegalInformation, 'sireneVerifiedAt'>
export interface MerchantLegalInformationRepository { findLegalInformation(merchantId: string): Promise<MerchantLegalInformation | null>; upsertLegalInformation(patch: MerchantLegalInformationPatch): Promise<MerchantLegalInformation> }
