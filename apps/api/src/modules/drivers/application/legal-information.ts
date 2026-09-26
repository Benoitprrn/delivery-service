export type PostalAddress = { line1: string; line2: string | null; postalCode: string; city: string; countryCode: string; communeCode: string | null }

export function normalizeSiret(value: string): string { return value.replace(/[\s.-]/g, '') }
export function isValidSiret(value: string): boolean { if (!/^\d{14}$/.test(value)) return false; let sum = 0; for (let i = 0; i < 14; i += 1) { let n = Number(value[i]); if (i % 2 === 0) n *= 2; sum += n > 9 ? n - 9 : n } return sum % 10 === 0 }
// Écriture désormais uniquement via `modules/drivers/application/company-profile.ts` (Compte → Mon
// Entreprise, brouillon + complétude serveur) — ce type reste la forme de lecture partagée
// (`findLegalInformation`, réutilisée en interne par le mandat de facturation électronique).
export type DriverLegalInformation = { driverId: string; professionalName: string; siret: string; siren: string; legalAddress: PostalAddress; billingAddress: PostalAddress | null; vatNumber: string | null; vatRegime: 'assujetti' | 'franchise_en_base' | 'exonere' | null; legalForm: string | null }
