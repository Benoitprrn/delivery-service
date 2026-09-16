import type { MerchantLogo, MerchantLogoStorage } from '../ports/merchant-logo-storage.js'

const BUCKET = 'merchant-logos'

export class SupabaseMerchantLogoStorage implements MerchantLogoStorage {
  public constructor(private readonly supabaseUrl: string, private readonly serviceRoleKey: string | undefined) {}

  public async upload(logo: MerchantLogo): Promise<string> {
    if (this.serviceRoleKey === undefined) {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY is required to upload merchant logos')
    }
    const path = `merchants/${logo.merchantId}/logo`
    const response = await fetch(`${this.supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.serviceRoleKey}`,
        apikey: this.serviceRoleKey,
        'content-type': logo.contentType,
        'x-upsert': 'true'
      },
      body: new Uint8Array(logo.content)
    })
    if (!response.ok) throw new Error(`Supabase Storage responded with ${response.status}`)
    return `${this.supabaseUrl}/storage/v1/object/public/${BUCKET}/${path}`
  }
}
