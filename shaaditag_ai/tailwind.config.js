/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ivory: {
          DEFAULT: '#FDFBF7',
          warm: '#F7F2E7',
          card: '#FFFEFA',
          border: '#E8DEC8',
        },
        sindoor: {
          DEFAULT: '#7A1C24',
          dark: '#581218',
          light: '#9E2A34',
          muted: '#F9ECEE',
        },
        marigold: {
          DEFAULT: '#D99B26',
          dark: '#B57D14',
          light: '#F4DCA9',
          muted: '#FCF5E5',
        },
        charcoal: {
          DEFAULT: '#1F1A1C',
          muted: '#5A4E52',
          light: '#85767B',
        },
      },
      fontFamily: {
        serif: ['"Cormorant Garamond"', '"Playfair Display"', 'Georgia', 'serif'],
        sans: ['"Plus Jakarta Sans"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      boxShadow: {
        'editorial': '0 10px 30px -10px rgba(122, 28, 36, 0.08), 0 4px 12px -2px rgba(217, 155, 38, 0.06)',
        'editorial-hover': '0 18px 38px -10px rgba(122, 28, 36, 0.14), 0 6px 16px -2px rgba(217, 155, 38, 0.12)',
      }
    },
  },
  plugins: [],
}
