// Design system Terrain — tokens copiés depuis design-system/terrain/tailwind.config.ts
// tels quels (voir CLAUDE.md racine). Seul `content` est adapté à la
// structure de cette app Expo, et `fontFamily.sans` référence le nom exact
// enregistré par expo-font (voir app/_layout.tsx) plutôt qu'une variable CSS.
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#ECFDF5',
          100: '#D1FAE5',
          200: '#A7F3D0',
          300: '#6EE7B7',
          400: '#34D399',
          500: '#10B981',
          600: '#059669', // brand primary
          700: '#047857',
          800: '#065F46',
          900: '#064E3B',
          DEFAULT: '#059669'
        },
        accent: {
          50: '#FFFBEB',
          100: '#FEF3C7',
          200: '#FDE68A',
          300: '#FCD34D',
          400: '#FBBF24',
          500: '#F59E0B', // amber accent
          600: '#D97706',
          700: '#B45309',
          800: '#92400E',
          900: '#78350F',
          DEFAULT: '#F59E0B'
        },
        stone: {
          50: '#FAFAF9',
          100: '#F5F5F4',
          200: '#E7E5E4',
          300: '#D6D3D1',
          400: '#A8A29E',
          500: '#78716C',
          600: '#57534E',
          700: '#44403C',
          800: '#292524',
          900: '#1C1917'
        },
        background: '#FDFCF8',
        surface: '#FFFFFF',
        border: '#E7E0D5',
        status: {
          pending: { bg: '#FEF3C7', text: '#92400E', dot: '#F59E0B' },
          assigned: { bg: '#DBEAFE', text: '#1D4ED8', dot: '#2563EB' },
          active: { bg: '#059669', text: '#FFFFFF', dot: '#FFFFFF' },
          delivered: { bg: '#ECFDF5', text: '#065F46', dot: '#059669' },
          paid: { bg: '#D1FAE5', text: '#065F46', dot: '#047857' },
          return: { bg: '#FFEDD5', text: '#C2410C', dot: '#F97316' },
          cancelled: { bg: '#FEE2E2', text: '#B91C1C', dot: '#EF4444' }
        }
      },
      fontFamily: {
        // React Native ne varie pas le poids d'une police custom via
        // fontWeight — chaque graisse DM Sans est enregistrée sous son
        // propre nom de famille dans app/_layout.tsx et exposée ici comme
        // utilitaire dédié (font-sans-medium, etc.) plutôt que via font-bold.
        sans: ['DM Sans'],
        'sans-medium': ['DM Sans Medium'],
        'sans-semibold': ['DM Sans SemiBold'],
        'sans-bold': ['DM Sans Bold'],
        mono: ['SFMono-Regular', 'Consolas', 'Liberation Mono', 'monospace']
      },
      fontSize: {
        display: ['48px', { lineHeight: '1.1', fontWeight: '700', letterSpacing: '-0.02em' }],
        h1: ['36px', { lineHeight: '1.2', fontWeight: '700', letterSpacing: '-0.02em' }],
        h2: ['28px', { lineHeight: '1.2', fontWeight: '700', letterSpacing: '-0.015em' }],
        h3: ['22px', { lineHeight: '1.3', fontWeight: '600', letterSpacing: '-0.01em' }],
        'body-lg': ['17px', { lineHeight: '1.6' }],
        body: ['15px', { lineHeight: '1.6' }],
        'body-sm': ['13px', { lineHeight: '1.5' }],
        label: ['12px', { lineHeight: '1.4', fontWeight: '600' }],
        caption: ['11px', { lineHeight: '1.4', fontWeight: '500', letterSpacing: '0.02em' }]
      },
      spacing: {
        px: '1px',
        '0.5': '2px',
        '1': '4px',
        '2': '8px',
        '3': '12px',
        '4': '16px',
        '5': '20px',
        '6': '24px',
        '7': '28px',
        '8': '32px',
        '9': '36px',
        '10': '40px',
        '11': '44px',
        '12': '48px',
        '13': '52px',
        '14': '56px',
        '16': '64px',
        '20': '80px',
        '24': '96px',
        '32': '128px',
        'page-mobile': '16px',
        'page-tablet': '24px',
        'page-desktop': '32px',
        'touch-min': '44px',
        'touch-comfortable': '52px'
      },
      borderRadius: {
        sm: '6px',
        md: '10px',
        DEFAULT: '10px',
        lg: '14px',
        xl: '20px',
        '2xl': '28px',
        full: '9999px'
      },
      zIndex: {
        base: '0',
        raised: '10',
        dropdown: '100',
        sticky: '200',
        overlay: '300',
        modal: '400',
        toast: '500',
        tooltip: '600'
      }
    }
  },
  plugins: []
};
