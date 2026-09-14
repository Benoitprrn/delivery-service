import nextConfig from 'eslint-config-next'
import tseslint from 'typescript-eslint'

// eslint-plugin-react@7.37.5 (dernière version publiée à ce jour) appelle
// encore context.getFilename(), retiré par ESLint 10 — chaque règle react/*
// plante au chargement. On les désactive explicitement (react-hooks,
// jsx-a11y et les règles @next/next restent actives) en attendant un
// correctif upstream. Voir https://github.com/jsx-eslint/eslint-plugin-react.
const reactRuleNames = Object.keys(nextConfig[0].rules).filter((name) => name.startsWith('react/'))
const disabledReactRules = Object.fromEntries(reactRuleNames.map((name) => [name, 'off']))

const config = [
  ...nextConfig,
  {
    // Le parser Babel maison d'eslint-config-next (utilisé pour
    // **/*.{js,jsx,mjs,...}) plante aussi sous ESLint 10
    // (`scopeManager.addGlobals is not a function`). Le parser
    // typescript-eslint — déjà utilisé pour .ts/.tsx via le bloc
    // "next/typescript" — parse du JS classique sans problème.
    files: ['**/*.{js,jsx,mjs,ts,tsx,mts,cts}'],
    languageOptions: {
      parser: tseslint.parser
    }
  },
  {
    files: ['**/*.{js,jsx,mjs,ts,tsx,mts,cts}'],
    rules: disabledReactRules
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  }
]

export default config
