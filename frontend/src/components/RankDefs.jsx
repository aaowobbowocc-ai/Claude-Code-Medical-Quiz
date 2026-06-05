/**
 * 段位框 / 名次獎牌共用的 SVG 漸層定義。整個排行榜只渲染一次（隱藏 svg），
 * RankFrame / RankMedal 以 url(#id) 引用。放一份避免每列重複。
 */
import React from 'react'

export default function RankDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        {/* 框金屬（斜向） */}
        <linearGradient id="rfBronze" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#f0b988" /><stop offset=".5" stopColor="#8b4513" /><stop offset="1" stopColor="#cd7f32" /></linearGradient>
        <linearGradient id="rfSilver" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset=".5" stopColor="#8e979f" /><stop offset="1" stopColor="#dfe5ea" /></linearGradient>
        <linearGradient id="rfGold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff3b0" /><stop offset=".5" stopColor="#e0a516" /><stop offset="1" stopColor="#9c6c08" /></linearGradient>
        <linearGradient id="rfDia" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#eafdff" /><stop offset=".5" stopColor="#56cfe1" /><stop offset="1" stopColor="#2f6bd8" /></linearGradient>
        <linearGradient id="rfKing" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff0a8" /><stop offset=".5" stopColor="#ff7e3e" /><stop offset="1" stopColor="#c026d3" /></linearGradient>
        {/* 獎牌寶石（放射） */}
        <radialGradient id="medGold" cx=".4" cy=".34"><stop offset="0" stopColor="#fff7cc" /><stop offset=".5" stopColor="#ffce43" /><stop offset="1" stopColor="#b9790a" /></radialGradient>
        <radialGradient id="medSilver" cx=".4" cy=".34"><stop offset="0" stopColor="#ffffff" /><stop offset=".5" stopColor="#dde4ea" /><stop offset="1" stopColor="#8d969f" /></radialGradient>
        <radialGradient id="medBronze" cx=".4" cy=".34"><stop offset="0" stopColor="#ffd9ad" /><stop offset=".5" stopColor="#d2873a" /><stop offset="1" stopColor="#7e3d11" /></radialGradient>
        <radialGradient id="medSteel" cx=".4" cy=".34"><stop offset="0" stopColor="#6b7686" /><stop offset=".5" stopColor="#454f5e" /><stop offset="1" stopColor="#232a35" /></radialGradient>
        {/* 獎牌金屬框（線性） */}
        <linearGradient id="bzGold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff3b0" /><stop offset=".5" stopColor="#e8b32e" /><stop offset="1" stopColor="#9c6c08" /></linearGradient>
        <linearGradient id="bzSilver" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" /><stop offset=".5" stopColor="#c4ccd3" /><stop offset="1" stopColor="#828b94" /></linearGradient>
        <linearGradient id="bzBronze" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f0c79a" /><stop offset=".5" stopColor="#bb7330" /><stop offset="1" stopColor="#6f3510" /></linearGradient>
        <linearGradient id="bzSteel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#8893a3" /><stop offset=".5" stopColor="#49525f" /><stop offset="1" stopColor="#222934" /></linearGradient>
      </defs>
    </svg>
  )
}
