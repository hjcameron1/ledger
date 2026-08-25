/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // `brand` is the single accent token the design-kit components reference as
        // text-brand / bg-brand / border-brand. Mapped to Ledger's blue so adopting
        // the kit keeps Ledger's colour identity. `.blue` kept for legacy usages.
        // The kit ships a purple brand (#6d5efc); we keep Ledger's blue identity.
        // `brand-dark` is the hover shade the kit's .btn-primary/.btn-ghost expect.
        brand: {
          DEFAULT: '#3b7dd8',
          dark: '#3070c8',
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
        // Softer and tighter than the originals. A card at rest is sitting on
        // the page, not floating above it; only a card you can pick up (hover)
        // gets real elevation, and even then it lifts rather than blooms.
        card: '0 1px 2px rgba(24,24,27,0.04), 0 1px 1px rgba(24,24,27,0.03)',
        'card-hover': '0 6px 16px -6px rgba(24,24,27,0.14)',
        'card-dark': '0 1px 3px rgba(0,0,0,0.4)',
      },
    },
  },
  plugins: [],
};
