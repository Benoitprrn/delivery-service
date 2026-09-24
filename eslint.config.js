// @ts-check
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.next/**', '**/.expo/**', 'infra/**']
  },
  {
    rules: {
      // Le pattern domain/application/ports/infrastructure/transport dépend
      // volontairement de fonctions déclarées plus bas dans le même fichier
      // pendant l'étape 3 — pas de règle no-use-before-define stricte ici.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    // Fichiers de config CommonJS attendus par les outils Expo/Metro/Babel
    // (chargés par Node directement, hors du bundler) — jamais ESM ici.
    files: ['apps/mobile/babel.config.js', 'apps/mobile/metro.config.js', 'apps/mobile/tailwind.config.js', 'apps/mobile/app.config.js'],
    languageOptions: {
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly', process: 'readonly' }
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    // Scripts Node exécutés directement (jamais par le bundler Expo/Metro) — besoin des globals Node standard.
    files: ['apps/mobile/scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' }
    }
  }
)
