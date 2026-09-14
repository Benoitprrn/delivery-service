/**
 * Vérification croisée de la colonne générée SQL : la base reste la source de
 * vérité à l'écriture. Les opérations sont volontairement entières, comme SQL.
 */
export function computePriceCents(distanceM: number, durationS: number): number {
  const distanceComponent = Math.floor((distanceM * 37) / 1_000)
  const durationComponent = Math.floor((durationS * 22) / 60)

  return Math.max(400, 100 + distanceComponent + durationComponent)
}
