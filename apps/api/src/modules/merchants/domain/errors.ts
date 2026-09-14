export class MerchantNotFoundError extends Error {
  public constructor(message = 'Merchant was not found') {
    super(message)
    this.name = 'MerchantNotFoundError'
  }
}
