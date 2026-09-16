export class InvalidMerchantLogoError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'InvalidMerchantLogoError'
  }
}
