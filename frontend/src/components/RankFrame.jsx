/**
 * 段位框 — 把排行榜整列包成對應段位的華麗長方形框。
 * tier: 'bronze' | 'silver' | 'gold' | 'diamond' | 'king'（'none' 不套框，直接回 children 容器）。
 * 裝飾全 SVG/CSS（見 rankframes.css）；依賴 <RankDefs/> 的漸層。
 */
import React from 'react'
import '../styles/rankframes.css'

const CFG = {
  bronze:  { m: 'rfBronze', g: '#e8a76a', corner: 'stud' },
  silver:  { m: 'rfSilver', g: '#cbd5e1', corner: 'simpleGem' },
  gold:    { m: 'rfGold',   g: '#ffd24a', corner: 'gem',   vine: ['#9c6c08', '#fff3b0', '#ffd24a'], pat: 1, mid: 1 },
  diamond: { m: 'rfDia',    g: '#5bc8ff', corner: 'gem',   vine: ['#2f6bd8', '#eafdff', '#7ee8ff'], pat: 1, mid: 1 },
  king:    { m: 'rfKing',   g: '#ff5b5b', corner: 'gem',   vine: ['#c026d3', '#fff0a8', '#ffd24a'], pat: 1, mid: 1, emblem: 1 },
}

function studCorner(m) {
  return `<path d="M9 38 L9 16 Q9 9 16 9 L38 9" fill="none" stroke="url(#${m})" stroke-width="3" stroke-linecap="round"/>
    <circle cx="12" cy="12" r="3.4" fill="url(#${m})" stroke="#fff" stroke-width=".6" stroke-opacity=".5"/>
    <circle cx="10.6" cy="10.6" r="1" fill="#fff" opacity=".7"/>`
}
function gemCorner(m, g, simple) {
  const ring = simple ? '' : `<circle r="9" fill="none" stroke="url(#${m})" stroke-width="2.2"/><circle r="9" fill="none" stroke="#fff" stroke-width=".5" opacity=".4"/>`
  return `<path d="M9 38 L9 16 Q9 9 16 9 L38 9" fill="none" stroke="url(#${m})" stroke-width="3.4" stroke-linecap="round"/>
    <path d="M12.5 38 L12.5 17 Q12.5 12.5 17 12.5 L38 12.5" fill="none" stroke="#fff" stroke-width=".9" opacity=".4" stroke-linecap="round"/>
    <g class="rf-gemtwinkle" transform="translate(12,12)">${ring}
      <polygon points="0,-7 5,-5 7,0 5,5 0,7 -5,5 -7,0 -5,-5" fill="${g}" stroke="#fff" stroke-width=".7" stroke-opacity=".7"/>
      <g stroke="#00000055" stroke-width=".5"><line x1="0" y1="-7" x2="0" y2="7"/><line x1="-7" y1="0" x2="7" y2="0"/><line x1="-5" y1="-5" x2="5" y2="5"/><line x1="5" y1="-5" x2="-5" y2="5"/></g>
      <polygon points="0,-7 5,-5 0,0 -5,-5" fill="#fff" opacity=".5"/><circle cx="-2" cy="-2" r="1.1" fill="#fff"/>
    </g>`
}
function cornerMarkup(t) {
  if (t.corner === 'stud') return studCorner(t.m)
  if (t.corner === 'simpleGem') return gemCorner(t.m, t.g, true)
  return gemCorner(t.m, t.g, false)
}
function wingEmblemMarkup(m, g) {
  return `<g fill="url(#${m})" stroke="#7a4d00" stroke-width=".8">
      <path d="M30 18 q-10 -10 -26 -9 q6 5 4 9 q8 -3 13 1 q-7 0 -10 4 q9 -2 19 -6 Z"/>
      <path d="M42 18 q10 -10 26 -9 q-6 5 -4 9 q-8 -3 -13 1 q7 0 10 4 q-9 -2 -19 -6 Z"/>
    </g>
    <polygon points="36,4 42,16 36,30 30,16" fill="${g}" stroke="#fff" stroke-width=".8"/>
    <polygon points="36,4 42,16 36,16 30,16" fill="#fff" opacity=".5"/>
    <circle cx="36" cy="16" r="1.5" fill="#fff"/>`
}
const Corner = ({ pos, html }) => (
  <svg className={`rf-corner ${pos}`} viewBox="0 0 40 40" dangerouslySetInnerHTML={{ __html: html }} />
)

export default function RankFrame({ tier, className = '', children }) {
  const t = CFG[tier]
  if (!t) return <div className={className}>{children}</div>
  const cm = cornerMarkup(t)
  return (
    <div className={`rankframe rf-${tier} ${t.pat ? 'rf-pat' : ''} ${className}`}>
      {t.emblem && (
        <svg className="rf-emblem" width="72" height="34" viewBox="0 0 72 34"
          dangerouslySetInnerHTML={{ __html: wingEmblemMarkup(t.m, t.g) }} />
      )}
      {['tl', 'tr', 'bl', 'br'].map((p) => <Corner key={p} pos={p} html={cm} />)}
      {t.mid && (
        <>
          <div className="rf-edge top" />
          <div className="rf-edge bot" />
        </>
      )}
      <div className="rf-inner">{children}</div>
    </div>
  )
}
