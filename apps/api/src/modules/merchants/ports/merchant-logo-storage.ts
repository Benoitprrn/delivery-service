export type MerchantLogo = {
  merchantId: string
  content: Buffer
  contentType: 'image/jpeg' | 'image/png'
}

export interface MerchantLogoStorage {
  upload(logo: MerchantLogo): Promise<string>
}
