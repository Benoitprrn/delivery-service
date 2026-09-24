import type { FrenchDirectoryProvider } from '../ports/french-directory-provider.js'
import type { FrenchDirectoryEntry } from '../domain/directory-selection.js'
import { SuperPdpOAuthClient } from './superpdp-oauth-client.js'

export class SuperPdpFrenchDirectoryProvider implements FrenchDirectoryProvider {
  public constructor(private readonly baseUrl: string, private readonly oauth: SuperPdpOAuthClient, private readonly fetcher: typeof fetch = fetch) {}
  public async lookupBySiren(siren: string): Promise<FrenchDirectoryEntry[]> {
    let response: Response
    try {
      response = await this.fetcher(`${this.baseUrl}/v1.beta/french_directory/entries?number=${encodeURIComponent(siren)}`, { headers: { authorization: `Bearer ${await this.oauth.accessToken()}` } })
    } catch { throw new Error('Super PDP directory lookup failed') }
    if (!response.ok) throw new Error(`Super PDP directory lookup failed with HTTP ${response.status}`)
    const body = await response.json() as { data?: Array<{ identifier: string; is_active: boolean }> }
    return (body.data ?? []).map((entry) => ({ identifier: entry.identifier, isActive: entry.is_active }))
  }
}
