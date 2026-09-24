type Token = { access_token: string; expires_in?: number; token_type?: string }

/** Process-local client_credentials cache. Tokens and secrets are deliberately never logged. */
export class SuperPdpOAuthClient {
  private cached: { value: string; expiresAt: number } | null = null
  public constructor(private readonly baseUrl: string, private readonly clientId: string, private readonly clientSecret: string, private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = Date.now) {}
  public async accessToken(): Promise<string> {
    if (this.cached !== null && this.cached.expiresAt > this.now()) return this.cached.value
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.clientId, client_secret: this.clientSecret })
    const response = await this.fetcher(`${this.baseUrl}/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
    if (!response.ok) throw new Error(`Super PDP OAuth failed with HTTP ${response.status}`)
    const token = await response.json() as Token
    if (typeof token.access_token !== 'string' || token.access_token === '') throw new Error('Super PDP OAuth response has no access_token')
    // Trust the server value. A small margin avoids handing a nearly expired token to a request.
    const expiresIn = typeof token.expires_in === 'number' && token.expires_in > 0 ? token.expires_in : 30 * 60
    this.cached = { value: token.access_token, expiresAt: this.now() + Math.max(1, expiresIn - 30) * 1_000 }
    return token.access_token
  }
}
