/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          'sans-serif',
        ],
        mono: [
          '"JetBrains Mono"',
          '"Fira Code"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace',
        ],
      },
      colors: {
        surface: {
          0: '#070b14',
          1: '#0c1220',
          2: '#111827',
          3: '#162033',
        },
      },
      boxShadow: {
        'glass': '0 1px 0 0 rgba(255, 255, 255, 0.06) inset, 0 12px 32px -12px rgba(2, 6, 23, 0.75)',
        'glow-indigo': '0 0 0 1px rgba(99, 102, 241, 0.35), 0 8px 24px -8px rgba(99, 102, 241, 0.45)',
        'glow-cyan': '0 0 0 1px rgba(34, 211, 238, 0.35), 0 8px 24px -8px rgba(34, 211, 238, 0.35)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(10px) scale(0.98)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 180ms ease-out',
        'slide-up': 'slide-up 200ms cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};
