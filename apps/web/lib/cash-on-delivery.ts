// Paiement à la livraison (COD) : bornes produit alignées sur l'API et la base
// (centimes entiers, EUR uniquement). Voir packages/shared et la migration 0027.
export const COD_MIN_CENTS = 100
export const COD_MAX_CENTS = 50_000

export type OrderCashOnDelivery = {
  required: boolean
  amountCents: number | null
  currency: 'eur' | null
  collected: boolean
}

// Saisie en euros (virgule ou point, 2 décimales max) → centimes entiers.
// Aucune arithmétique flottante : le montant ne transite jamais par un float.
export function parseEurosToCents(input: string): number | null {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(input.trim())
  if (match === null) {
    return null
  }
  const euros = Number(match[1])
  const decimals = Number((match[2] ?? '').padEnd(2, '0'))
  const cents = euros * 100 + decimals
  return cents >= COD_MIN_CENTS && cents <= COD_MAX_CENTS ? cents : null
}
