import { SireneProviderResponseError, SireneRestrictedError, SiretNotFoundError, SireneUnavailableError, type PostalAddress, type SireneLegalInformation, type SireneProvider } from '../ports/sirene-provider.js'

function record(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null }
function string(value: unknown): string | null { return typeof value === 'string' && value.trim() !== '' ? value.trim() : null }
function address(source: Record<string, unknown>): PostalAddress {
  // Sirene 3.11 nests the current postal address under adresseEtablissement.
  // Keep the source fallback only for the provider's older fixtures.
  const value = record(source.adresseEtablissement) ?? source
  const line1 = [string(value.numeroVoieEtablissement), string(value.indiceRepetitionEtablissement), string(value.typeVoieEtablissement), string(value.libelleVoieEtablissement)].filter((x): x is string => x !== null).join(' ')
  const postalCode = string(value.codePostalEtablissement); const city = string(value.libelleCommuneEtablissement)
  if (!line1 || !postalCode || !city) throw new SireneProviderResponseError('Sirene response has an incomplete address')
  // Sirene identifies foreign countries with its own code, not an ISO-3166-1
  // alpha-2 value. The current onboarding only accepts French establishments.
  return { line1, line2: string(value.complementAdresseEtablissement), postalCode, city, countryCode: 'FR', communeCode: string(value.codeCommuneEtablissement) }
}
function legalName(unit: Record<string, unknown>): string {
  const denomination = string(unit.denominationUniteLegale); if (denomination) return denomination
  const surname = string(unit.nomUsageUniteLegale) ?? string(unit.nomUniteLegale)
  const first = string(unit.prenomUsuelUniteLegale) ?? string(unit.prenom1UniteLegale)
  const result = [first, surname].filter((x): x is string => x !== null).join(' '); if (!result) throw new SireneProviderResponseError('Sirene response has no legal name'); return result
}
function establishmentIsActive(establishment: Record<string, unknown>): boolean {
  const periods = establishment.periodesEtablissement
  if (!Array.isArray(periods)) throw new SireneProviderResponseError('Sirene response has no establishment periods')
  const current = periods.map(record).find((period): period is Record<string, unknown> => period !== null && period.dateFin === null)
  if (current === undefined) throw new SireneProviderResponseError('Sirene response has no current establishment period')
  return string(current.etatAdministratifEtablissement) === 'A'
}
function hasPartialDissemination(establishment: Record<string, unknown>, unit: Record<string, unknown>): boolean {
  return establishment.statutDiffusionEtablissement === 'P' || unit.statutDiffusionUniteLegale === 'P'
}
export class InseeSireneProvider implements SireneProvider {
  public constructor(private readonly apiKey: string, private readonly baseUrl = 'https://api.insee.fr/api-sirene/3.11') {}
  public async lookupBySiret(siret: string): Promise<SireneLegalInformation> {
    const get = async (id: string): Promise<Record<string, unknown>> => {
      let response: Response; try { response = await fetch(`${this.baseUrl}/siret/${id}`, { headers: { 'X-INSEE-Api-Key-Integration': this.apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(5_000) }) } catch (error) { throw new SireneUnavailableError(undefined, error) }
      if (response.status === 404) throw new SiretNotFoundError(); if (response.status === 403 || response.status === 401) throw new SireneRestrictedError(); if (response.status === 429 || response.status >= 500) throw new SireneUnavailableError(`Sirene returned HTTP ${response.status}`); if (!response.ok) throw new SireneProviderResponseError(`Sirene returned HTTP ${response.status}`)
      const body = record(await response.json().catch(() => null)); const establishment = body && record(body.etablissement); if (!establishment) throw new SireneProviderResponseError(); return establishment
    }
    const entered = await get(siret); const unit = record(entered.uniteLegale); const siren = string(entered.siren); if (!unit || !siren) throw new SireneProviderResponseError()
    // Sirene 3.11 exposes the current partial-dissemination code as P. In
    // particular, an entrepreneur individuel can oppose publication of
    // personal data. Do not use any partially disseminated fields to prefill
    // the legal form; the merchant may still enter their details manually.
    if (hasPartialDissemination(entered, unit)) throw new SireneRestrictedError()
    const isHeadquarters = entered.etablissementSiege === true; const nic = string(unit.nicSiegeUniteLegale); const source = isHeadquarters ? entered : nic ? await get(`${siren}${nic}`) : null
    if (!source) throw new SireneProviderResponseError('Sirene response has no headquarters SIRET')
    return { siret, siren, legalName: legalName(unit), legalAddress: address(source), establishmentActive: establishmentIsActive(entered), legalUnitActive: string(unit.etatAdministratifUniteLegale) === 'A' }
  }
}
