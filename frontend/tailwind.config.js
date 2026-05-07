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
        // 抽獎動畫
        gachaShake:  { '0%,100%': { transform: 'rotate(0)' }, '25%': { transform: 'rotate(-3deg)' }, '75%': { transform: 'rotate(3deg)' } },
        gachaBall:   { '0%,100%': { transform: 'translate(0,0)' }, '25%': { transform: 'translate(10px,-12px)' }, '50%': { transform: 'translate(-8px,10px)' }, '75%': { transform: 'translate(12px,4px)' } },
        gachaKnob:   { from: { transform: 'rotate(0)' }, to: { transform: 'rotate(720deg)' } },
        cardShuffle: { '0%,100%': { transform: 'translateY(0) rotate(0)' }, '50%': { transform: 'translateY(-20px) rotate(-10deg)' } },
        fukubukuroAnim: { '0%,100%': { transform: 'translateY(0) rotate(0) scale(1)' }, '20%': { transform: 'translateY(-15px) rotate(-12deg) scale(1.08)' }, '40%': { transform: 'translateY(0) rotate(8deg) scale(1)' }, '60%': { transform: 'translateY(-8px) rotate(-6deg) scale(1.04)' }, '80%': { transform: 'translateY(0) rotate(3deg) scale(1)' } },
        sparkle:     { '0%,100%': { opacity: '0.3', transform: 'scale(0.7)' }, '50%': { opacity: '1', transform: 'scale(1.3)' } },
        revealPop:   { '0%': { opacity: '0', transform: 'scale(0.5) translateY(40px)' }, '70%': { opacity: '1', transform: 'scale(1.05) translateY(-4px)' }, '100%': { opacity: '1', transform: 'scale(1) translateY(0)' } },
      },
      animation: {
        pop:   'pop 0.3s ease-out',
        shake: 'shake 0.4s ease-out',
        'gacha-shake':  'gachaShake 0.4s ease-in-out infinite',
        'gacha-ball':   'gachaBall 0.6s ease-in-out infinite',
        'gacha-knob':   'gachaKnob 1.2s linear infinite',
        'card-shuffle': 'cardShuffle 0.5s ease-in-out infinite',
        'fukubukuro':   'fukubukuroAnim 0.5s ease-in-out infinite',
        'sparkle':      'sparkle 1s ease-in-out infinite',
        'reveal-pop':   'revealPop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both',
      },
    },
  },
  plugins: [],
}
