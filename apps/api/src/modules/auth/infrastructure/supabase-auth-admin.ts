import { AccountAlreadyExistsError, AuthProviderError } from '../domain/auth-admin-errors.js'
import type { AuthAdmin, AuthUserLookup, CreateAuthUserInput } from '../ports/auth-admin.js'

export class SupabaseAuthAdmin implements AuthAdmin, AuthUserLookup {
  public constructor(private readonly supabaseUrl: string, private readonly serviceRoleKey: string) {}

  public async createUser(input: CreateAuthUserInput): Promise<void> {
    const response = await this.request('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        id: input.id,
        email: input.email,
        password: input.password,
        email_confirm: true,
        app_metadata: input.appMetadata
      })
    })
    if (response.ok) return

    const body = await response.json().catch(() => null) as { msg?: unknown; message?: unknown } | null
    const message = typeof body?.msg === 'string' ? body.msg : typeof body?.message === 'string' ? body.message : ''
    // GoTrue's duplicate response is 422 with "User already registered".
    if (response.status === 422 && /already registered|already exists/i.test(message)) throw new AccountAlreadyExistsError()
    throw new AuthProviderError(`Supabase Auth admin user creation failed with status ${response.status}`)
  }

  public async deleteUser(id: string): Promise<void> {
    const response = await this.request(`/auth/v1/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!response.ok) throw new AuthProviderError(`Supabase Auth admin user deletion failed with status ${response.status}`)
  }

  public async getUserEmail(id: string): Promise<string | null> {
    const response = await this.request(`/auth/v1/admin/users/${encodeURIComponent(id)}`, { method: 'GET' })
    if (response.status === 404) return null
    if (!response.ok) throw new AuthProviderError(`Supabase Auth admin user lookup failed with status ${response.status}`)
    const body = await response.json().catch(() => null) as { email?: unknown } | null
    return typeof body?.email === 'string' && body.email.trim() !== '' ? body.email : null
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.supabaseUrl}${path}`, {
        ...init,
        headers: {
          apikey: this.serviceRoleKey,
          Authorization: `Bearer ${this.serviceRoleKey}`,
          'Content-Type': 'application/json'
        }
      })
    } catch {
      throw new AuthProviderError('Supabase Auth admin request failed')
    }
  }
}
