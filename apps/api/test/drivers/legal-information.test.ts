import { describe, expect, it } from 'vitest'
import { isValidSiret, normalizeSiret } from '../../src/modules/drivers/application/legal-information.js'

// La seule écriture de driver_legal_information passe désormais par
// modules/drivers/application/company-profile.ts (Compte → Mon Entreprise, brouillon +
// complétude serveur, 2026-09-25) — voir test/drivers/company-profile.integration.test.ts.
// Ces deux fonctions pures restent partagées (réutilisées par company-profile.ts).
describe('driver SIRET normalization/validation', () => {
  it('normalizes and validates a SIRET with the same Luhn check as merchants, without importing across modules', () => {
    expect(normalizeSiret('732 829 320-00074')).toBe('73282932000074')
    expect(isValidSiret('73282932000074')).toBe(true)
    expect(isValidSiret('73282932000075')).toBe(false)
    expect(isValidSiret('123')).toBe(false)
  })
})
