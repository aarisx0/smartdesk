/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/renderer/**/*.{ts,tsx,js,jsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        navy: {
          900: '#0F0F1A',
          800: '#14142B',
          700: '#1A1A35',
          600: '#20204A',
        },
        accent: {
          blue: '#4F46E5',
          violet: '#7C3AED',
          cyan: '#06B6D4',
        },
      },
      backdropBlur: {
        xs: '2px',
      },
      animation: {
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 4px rgba(79,70,229,0.4)' },
          '50%': { boxShadow: '0 0 16px rgba(79,70,229,0.8)' },
        },
      },
    },
  },
  plugins: [],
};
