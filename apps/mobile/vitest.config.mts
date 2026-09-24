import { defineConfig } from 'vitest/config'

// Couvre uniquement la logique pure de `lib/` (aucune dépendance React Native) — ce dépôt n'a
// aucune infrastructure de test de composant React Native (ni jest-expo, ni testing-library) pour
// aucun écran existant ; ne pas en introduire une pour ce seul écran, voir docs/work/
// invoicing-preparation-plan.md §15 (Tranche 4c) pour la portée exacte des tests couverts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts']
  }
})
