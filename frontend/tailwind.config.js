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
        // 抽獎動畫 - 多階段
        gachaShake:  { '0%,100%': { transform: 'rotate(0)' }, '25%': { transform: 'rotate(-3deg)' }, '75%': { transform: 'rotate(3deg)' } },
        gachaBall:   { '0%,100%': { transform: 'translate(0,0)' }, '25%': { transform: 'translate(10px,-12px)' }, '50%': { transform: 'translate(-8px,10px)' }, '75%': { transform: 'translate(12px,4px)' } },
        gachaKnob:   { from: { transform: 'rotate(0)' }, to: { transform: 'rotate(720deg)' } },
        // 球從機器內掉到出口槽（垂直下落 + 反彈）
        gachaDrop: {
          '0%':   { top: '40%', transform: 'translateX(-50%) scale(0.8)', opacity: '0' },
          '20%':  { top: '40%', transform: 'translateX(-50%) scale(1)', opacity: '1' },
          '70%':  { top: '85%', transform: 'translateX(-50%) scale(1)' },
          '85%':  { top: '78%', transform: 'translateX(-50%) scale(1)' },  // bounce
          '100%': { top: '85%', transform: 'translateX(-50%) scale(1)' },
        },
        // 球滾出來
        gachaRoll: {
          '0%':   { left: '50%', transform: 'translateX(-50%) rotate(0)' },
          '100%': { left: '95%', transform: 'translateX(-50%) rotate(720deg)' },
        },
        // 球裂開 (上半飛走)
        gachaCrackTop: {
          '0%':   { transform: 'translate(0, 0) rotate(0)', opacity: '1' },
          '100%': { transform: 'translate(-30px, -50px) rotate(-60deg)', opacity: '0' },
        },
        gachaCrackBot: {
          '0%':   { transform: 'translate(0, 0) rotate(0)', opacity: '1' },
          '100%': { transform: 'translate(30px, 30px) rotate(60deg)', opacity: '0' },
        },
        // 翻牌：洗牌（上下飄）
        cardShuffle: { '0%,100%': { transform: 'translateY(0) rotate(0)' }, '50%': { transform: 'translateY(-20px) rotate(-10deg)' } },
        // 翻牌：選定的卡飛到中央放大
        cardSelect: {
          '0%':   { transform: 'scale(1) translateY(0)' },
          '100%': { transform: 'scale(1.6) translateY(-10px)' },
        },
        // 翻牌：3D 翻面
        cardFlip: {
          '0%':   { transform: 'scale(1.6) translateY(-10px) rotateY(0)' },
          '100%': { transform: 'scale(1.6) translateY(-10px) rotateY(180deg)' },
        },
        // 福袋搖晃
        fukubukuroAnim: { '0%,100%': { transform: 'translateY(0) rotate(0) scale(1)' }, '20%': { transform: 'translateY(-15px) rotate(-12deg) scale(1.08)' }, '40%': { transform: 'translateY(0) rotate(8deg) scale(1)' }, '60%': { transform: 'translateY(-8px) rotate(-6deg) scale(1.04)' }, '80%': { transform: 'translateY(0) rotate(3deg) scale(1)' } },
        // 福袋打開（袋口擴大）
        fukubukuroOpen: {
          '0%':   { transform: 'scaleY(1) scaleX(1)' },
          '100%': { transform: 'scaleY(0.7) scaleX(1.3)' },
        },
        // 禮物從袋口飛出（向上彈）
        giftPop: {
          '0%':   { transform: 'translateY(0) scale(0)', opacity: '0' },
          '40%':  { transform: 'translateY(-50px) scale(1.1)', opacity: '1' },
          '70%':  { transform: 'translateY(-65px) scale(1)', opacity: '1' },
          '100%': { transform: 'translateY(-60px) scale(1)', opacity: '1' },
        },
        // 五彩紙花
        confetti: {
          '0%':   { transform: 'translate(0, 0) scale(0) rotate(0)', opacity: '0' },
          '20%':  { opacity: '1' },
          '100%': { transform: 'translate(var(--cx, 40px), var(--cy, -60px)) scale(1) rotate(720deg)', opacity: '0' },
        },
        sparkle:     { '0%,100%': { opacity: '0.3', transform: 'scale(0.7)' }, '50%': { opacity: '1', transform: 'scale(1.3)' } },
        revealPop:   { '0%': { opacity: '0', transform: 'scale(0.5) translateY(40px)' }, '70%': { opacity: '1', transform: 'scale(1.05) translateY(-4px)' }, '100%': { opacity: '1', transform: 'scale(1) translateY(0)' } },
      },
      animation: {
        pop:   'pop 0.3s ease-out',
        shake: 'shake 0.4s ease-out',
        'gacha-shake':  'gachaShake 0.4s ease-in-out infinite',
        'gacha-ball':   'gachaBall 0.6s ease-in-out infinite',
        'gacha-knob':   'gachaKnob 1.2s linear infinite',
        'gacha-drop':   'gachaDrop 0.8s cubic-bezier(0.5, 0, 0.5, 1) forwards',
        'gacha-roll':   'gachaRoll 0.8s ease-out forwards',
        'gacha-crack-top': 'gachaCrackTop 0.5s ease-in forwards',
        'gacha-crack-bot': 'gachaCrackBot 0.5s ease-in forwards',
        'card-shuffle': 'cardShuffle 0.5s ease-in-out infinite',
        'card-select':  'cardSelect 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards',
        'card-flip':    'cardFlip 0.6s cubic-bezier(0.4, 0, 0.2, 1) forwards',
        'fukubukuro':   'fukubukuroAnim 0.5s ease-in-out infinite',
        'fukubukuro-open': 'fukubukuroOpen 0.4s ease-out forwards',
        'gift-pop':     'giftPop 0.7s cubic-bezier(0.34, 1.56, 0.64, 1) forwards',
        'confetti':     'confetti 0.8s ease-out forwards',
        'sparkle':      'sparkle 1s ease-in-out infinite',
        'reveal-pop':   'revealPop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both',
      },
    },
  },
  plugins: [],
}
