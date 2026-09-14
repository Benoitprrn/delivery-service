import type { Pool } from 'pg'
import { MerchantNotFoundError } from '../domain/errors.js'
import type { Merchant } from '../domain/merchant.js'
import type { MerchantPatch, MerchantRepository } from '../ports/merchant-repository.js'

type MerchantRow = {
  id: string
  name: string
  zone_id: string
  address: string
  phone: string
  lat: number
  lng: number
}

export class PostgresMerchantRepository implements MerchantRepository {
  public constructor(private readonly pool: Pool) {}

  public async findById(id: string): Promise<Merchant | null> {
    const result = await this.pool.query<MerchantRow>(
      'select id, name, zone_id, address, phone, lat, lng from merchants where id = $1',
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
          phone: row.phone,
          lat: row.lat,
          lng: row.lng
        }
  }

  public async update(id: string, patch: MerchantPatch): Promise<Merchant> {
    const result = await this.pool.query<MerchantRow>(
      `update merchants
       set name = $1, phone = $2, address = $3, lat = $4, lng = $5
       where id = $6
       returning id, name, zone_id, address, phone, lat, lng`,
      [patch.name, patch.phone, patch.address, patch.lat, patch.lng, id]
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
      phone: row.phone,
      lat: row.lat,
      lng: row.lng
    }
  }
}
