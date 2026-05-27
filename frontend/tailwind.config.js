/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          blue: '#3b7dd8',
        },
        surface: {
          light: '#f5f5f5',
          dark: '#1a1a1a',
        },
        text: {
          secondary: {
            light: '#6b6b6b',
            dark: '#a0a0a0',
          },
        },
        success: '#22c55e',
        danger: '#ef4444',
        warning: '#f59e0b',
        border: {
          light: '#e5e5e5',
          dark: '#2a2a2a',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      borderRadius: {
        card: '12px',
      },
      transitionDuration: {
        fast: '150ms',
        smooth: '200ms',
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)',
        'card-hover': '0 4px 12px rgba(0,0,0,0.1)',
        'card-dark': '0 1px 3px rgba(0,0,0,0.4)',
      },
    },
  },
  plugins: [],
};
