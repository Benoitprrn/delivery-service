export type PostalAddress = { line1: string; line2: string | null; postalCode: string; city: string; countryCode: string; communeCode: string | null }
export type SireneLegalInformation = { siret: string; siren: string; legalName: string; legalAddress: PostalAddress; establishmentActive: boolean; legalUnitActive: boolean }
export interface SireneProvider { lookupBySiret(siret: string): Promise<SireneLegalInformation> }
export class SiretNotFoundError extends Error { public constructor() { super('SIRET was not found'); this.name = 'SiretNotFoundError' } }
export class SireneUnavailableError extends Error { public constructor(message = 'Sirene is temporarily unavailable', cause?: unknown) { super(message, { cause }); this.name = 'SireneUnavailableError' } }
export class SireneRestrictedError extends Error { public constructor() { super('Sirene data is not accessible for this SIRET'); this.name = 'SireneRestrictedError' } }
export class SireneProviderResponseError extends Error { public constructor(message = 'Sirene returned an invalid response') { super(message); this.name = 'SireneProviderResponseError' } }
export class UnavailableSireneProvider implements SireneProvider { public async lookupBySiret(): Promise<SireneLegalInformation> { throw new SireneUnavailableError('Sirene is not configured') } }
