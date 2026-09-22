export class MerchantNotFoundError extends Error {
  public constructor(message = 'Merchant was not found') {
    super(message)
    this.name = 'MerchantNotFoundError'
  }
}

export class MerchantProvisioningError extends Error {
  public constructor(message = 'Merchant profile provisioning failed') {
    super(message)
    this.name = 'MerchantProvisioningError'
  }
}

export class AddressOutsideZoneError extends Error {
  public constructor(message = 'Address is outside every delivery zone') { super(message); this.name = 'AddressOutsideZoneError' }
}

export class AmbiguousMerchantZoneError extends Error {
  public readonly point: { lat: number; lng: number }
  public readonly zones: { id: string; name: string }[]
  public constructor(point: { lat: number; lng: number }, zones: { id: string; name: string }[]) {
    super('Address matches multiple delivery zones')
    this.name = 'AmbiguousMerchantZoneError'
    this.point = point
    this.zones = zones
  }
}
