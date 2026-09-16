import type { Pool } from 'pg'
import { MerchantNotFoundError } from '../domain/errors.js'
import type { Merchant } from '../domain/merchant.js'
import type { MerchantPatch, MerchantRepository } from '../ports/merchant-repository.js'

type MerchantRow = {
  id: string
  name: string
  zone_id: string
  address: string
  phone_landline: string | null
  phone_mobile: string | null
  logo_url: string | null
  lat: number
  lng: number
}

export class PostgresMerchantRepository implements MerchantRepository {
  public constructor(private readonly pool: Pool) {}

  public async findById(id: string): Promise<Merchant | null> {
    const result = await this.pool.query<MerchantRow>(
      'select id, name, zone_id, address, phone_landline, phone_mobile, logo_url, lat, lng from merchants where id = $1',
      [id]
    )
    const row = result.rows[0]

    return row === undefined
      ? null
      : {
          id: row.id,
          name: row.name,
          zoneId: row.zone_id,
          address: row.address,
          phoneLandline: row.phone_landline,
          phoneMobile: row.phone_mobile,
          logoUrl: row.logo_url,
          lat: row.lat,
          lng: row.lng
        }
  }

  public async update(id: string, patch: MerchantPatch): Promise<Merchant> {
    const result = await this.pool.query<MerchantRow>(
      `update merchants
       set name = $1, phone_landline = $2, phone_mobile = $3, logo_url = $4, address = $5, lat = $6, lng = $7
       where id = $8
       returning id, name, zone_id, address, phone_landline, phone_mobile, logo_url, lat, lng`,
      [patch.name, patch.phoneLandline, patch.phoneMobile, patch.logoUrl, patch.address, patch.lat, patch.lng, id]
    )
    const row = result.rows[0]

    if (row === undefined) {
      throw new MerchantNotFoundError(`Merchant ${id} not found`)
    }

    return {
      id: row.id,
      name: row.name,
      zoneId: row.zone_id,
      address: row.address,
      phoneLandline: row.phone_landline,
      phoneMobile: row.phone_mobile,
      logoUrl: row.logo_url,
      lat: row.lat,
      lng: row.lng
    }
  }

  public async updateLogoUrl(id: string, logoUrl: string): Promise<Merchant> {
    const result = await this.pool.query<MerchantRow>(
      `update merchants set logo_url = $1 where id = $2
       returning id, name, zone_id, address, phone_landline, phone_mobile, logo_url, lat, lng`,
      [logoUrl, id]
    )
    const row = result.rows[0]
    if (row === undefined) throw new MerchantNotFoundError(`Merchant ${id} not found`)
    return {
      id: row.id, name: row.name, zoneId: row.zone_id, address: row.address,
      phoneLandline: row.phone_landline, phoneMobile: row.phone_mobile, logoUrl: row.logo_url,
      lat: row.lat, lng: row.lng
    }
  }
}
