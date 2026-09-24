export type MandateSeller = { legalName: string; siren: string; siret: string | null; addressLine1: string; addressLine2: string | null; postalCode: string; city: string; countryCode: string }
export interface MandatePdfRenderer { render(input: { templateText: string; fields: Record<string, string>; signatureImage: Buffer; acceptedAt: Date }): Promise<Buffer> }
