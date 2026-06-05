/**
 * 名次獎牌 — 珠邊金屬框 + 鑲釘 + 明亮式切面寶石 + 金屬名次牌。
 * 金/銀/銅 對應前三名，其餘鋼色。第 1 名頂部加小冠。
 * 依賴 <RankDefs/> 提供的漸層（整頁渲染一次）。
 */
import React from 'react'

const GEM = { 1: 'medGold', 2: 'medSilver', 3: 'medBronze' }
const BEZ = { 1: 'bzGold', 2: 'bzSilver', 3: 'bzBronze' }
const PLT = { 1: '#7a5200', 2: '#525b64', 3: '#5a2f0c' }
const gem = (n) => GEM[n] || 'medSteel'
const bez = (n) => BEZ[n] || 'bzSteel'
const plt = (n) => PLT[n] || '#c2ccd9'

const poly = (pts) => pts.map((p) => p.join(',')).join(' ')

// 明亮式切面寶石：base + 16 冠面 + 八角桌面，明暗交錯做折射
function brilliant(cx, cy, R, r, grad) {
  let s = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#${grad})"/>`
  const N = 16, M = 8
  const ring = (rad, n, off) => [...Array(n)].map((_, k) => {
    const a = (k / n) * 2 * Math.PI - Math.PI / 2 + off
    return [cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]
  })
  const Rp = ring(R, N, 0), Tp = ring(r, M, Math.PI / M)
  for (let k = 0; k < N; k++) {
    const a = Rp[k], b = Rp[(k + 1) % N], t = Tp[Math.floor((k + 1) / 2) % M]
    s += `<polygon points="${poly([a, b, t])}" fill="${k % 2 ? '#ffffff' : '#000000'}" fill-opacity="${k % 2 ? 0.16 : 0.14}" stroke="#00000022" stroke-width=".3"/>`
  }
  for (let k = 0; k < M; k++) {
    const a = Tp[k], b = Tp[(k + 1) % M]
    s += `<polygon points="${poly([[cx, cy], a, b])}" fill="${k % 2 ? '#ffffff' : '#000000'}" fill-opacity="${k % 2 ? 0.1 : 0.08}" stroke="#00000022" stroke-width=".3"/>`
  }
  s += `<polygon points="${poly(Tp)}" fill="none" stroke="#ffffff66" stroke-width=".6"/>`
  s += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#ffffff88" stroke-width=".8"/>`
  s += `<path d="M${cx - R * 0.7} ${cy - R * 0.3} A ${R} ${R} 0 0 1 ${cx + R * 0.1} ${cy - R * 0.95}" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".55"/>`
  return s
}

function medalMarkup(n) {
  const cx = 27, cy = 24, R = 15, r = 7
  let beads = ''
  const NB = 22
  for (let k = 0; k < NB; k++) {
    const a = (k / NB) * 2 * Math.PI
    beads += `<circle cx="${cx + Math.cos(a) * (R + 3.4)}" cy="${cy + Math.sin(a) * (R + 3.4)}" r="1.5" fill="url(#${bez(n)})" stroke="#0004" stroke-width=".3"/>`
  }
  let studs = ''
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * 2 * Math.PI - Math.PI / 2
    studs += `<circle cx="${cx + Math.cos(a) * (R + 3.4)}" cy="${cy + Math.sin(a) * (R + 3.4)}" r="2.3" fill="url(#${gem(n)})" stroke="#fff8" stroke-width=".5"/>`
  }
  const bezelRing = `<circle cx="${cx}" cy="${cy}" r="${R + 1.6}" fill="none" stroke="url(#${bez(n)})" stroke-width="3"/><circle cx="${cx}" cy="${cy}" r="${R + 3.1}" fill="none" stroke="#0005" stroke-width=".6"/>`
  const crown = n === 1
    ? `<path d="M19 5 L22 10 L27 4 L32 10 L35 5 L34 11 L20 11 Z" fill="url(#bzGold)" stroke="#7a4d00" stroke-width=".6" stroke-linejoin="round"/><circle cx="27" cy="3.6" r="1.8" fill="#ff5b5b" stroke="#fff" stroke-width=".4"/>`
    : ''
  const plate = `<g transform="translate(${cx},46)">
     <path d="M-11 -3 L11 -3 L9 7 L0 10 L-9 7 Z" fill="url(#${bez(n)})" stroke="#0006" stroke-width=".7"/>
     <text x="0" y="4.4" text-anchor="middle" font-size="9.5" font-weight="900" fill="${plt(n)}" font-family="system-ui">${n}</text>
   </g>`
  return `${crown}${beads}${bezelRing}${brilliant(cx, cy, R, r, gem(n))}${studs}${plate}`
}

export default function RankMedal({ rank, size = 30 }) {
  if (!rank || rank < 1) return null
  return (
    <svg
      width={size} height={size * (58 / 54)} viewBox="0 0 54 58"
      style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.45))', display: 'block' }}
      dangerouslySetInnerHTML={{ __html: medalMarkup(rank) }}
    />
  )
}
