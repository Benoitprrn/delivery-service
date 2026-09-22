import { inTransaction } from '../../../platform/transaction.js'
import { AmbiguousMerchantZoneError, AddressOutsideZoneError } from '../domain/errors.js'
import { MerchantNotFoundError } from '../domain/errors.js'
import type { Merchant } from '../domain/merchant.js'
import type { MerchantInformationPatch, MerchantRepository } from '../ports/merchant-repository.js'
import type { GeocodingProvider } from '../../geocoding/public.js'
import type { ZoneRepository } from '../../zones/public.js'
import type { Pool } from 'pg'

export type UpdateMerchantInformationCommand = Omit<MerchantInformationPatch, 'lat' | 'lng' | 'zoneId' | 'phoneSecondary'> & { phoneSecondary?: string | null | undefined }

export class UpdateMerchantInformationUseCase {
  public constructor(private readonly pool: Pool, private readonly merchantRepository: MerchantRepository, private readonly geocoding: GeocodingProvider, private readonly zones: ZoneRepository) {}
  public async execute(id: string, command: UpdateMerchantInformationCommand): Promise<Merchant> {
    // Return the contractual 404 before calling an external provider for a
    // profile that does not exist. The profile is read again in the local
    // transaction below so an omitted secondary number retains its current
    // value even if another update happens in between.
    const merchant = await this.merchantRepository.findById(id)
    if (merchant === null) throw new MerchantNotFoundError(`Merchant ${id} not found`)

    const point = await this.geocoding.geocode(command.address)
    const containing = await this.zones.findContainingPoint(point)
    if (containing.kind === 'none') throw new AddressOutsideZoneError()
    if (containing.kind === 'multiple') throw new AmbiguousMerchantZoneError(point, containing.zones.map(({ id, name }) => ({ id, name })))
    return inTransaction(this.pool, async (client) => {
      const existing = await this.merchantRepository.findById(id, client)
      if (existing === null) throw new MerchantNotFoundError(`Merchant ${id} not found`)
      return this.merchantRepository.updateInformation(id, {
        name: command.name, address: command.address, lat: point.lat, lng: point.lng, zoneId: containing.zone.id,
        phonePrimary: command.phonePrimary, phoneSecondary: command.phoneSecondary === undefined ? existing.phoneSecondary : command.phoneSecondary
      }, client)
    })
  }
}
