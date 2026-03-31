/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        medical: {
          white:   '#FFFFFF',
          ice:     '#F0F4F8',
          blue:    '#1A6B9A',
          teal:    '#0D9488',
          light:   '#E0F2F1',
          accent:  '#0284C7',
          danger:  '#DC2626',
          success: '#16A34A',
          gold:    '#D97706',
          dark:    '#0F2A3F',
        },
      },
      fontFamily: {
        sans: ['Noto Sans TC', 'system-ui', 'sans-serif'],
      },
      keyframes: {
        pop:   { '0%': { transform: 'scale(0.8)', opacity: '0' }, '70%': { transform: 'scale(1.08)' }, '100%': { transform: 'scale(1)', opacity: '1' } },
        shake: { '0%,100%': { transform: 'translateX(0)' }, '20%,60%': { transform: 'translateX(-8px)' }, '40%,80%': { transform: 'translateX(8px)' } },
      },
      animation: {
        pop:   'pop 0.3s ease-out',
        shake: 'shake 0.4s ease-out',
      },
    },
  },
  plugins: [],
}
