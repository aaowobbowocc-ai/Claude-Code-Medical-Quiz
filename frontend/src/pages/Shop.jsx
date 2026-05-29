/**
 * 商店頁面 — 邊框 / 頭像 / AI 無限包 三個分頁。
 *
 * 由 feature flag FEATURE_FRAMES / FEATURE_AVATARS / FEATURE_AI_UNLIMITED 控制
 * 是否顯示對應 tab。全部 OFF 時整個 /shop 頁面回 404。
 */
import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase, readAuthFromStorage } from '../lib/supabase'
import { usePlayerStore } from '../store/gameStore'
import AvatarWithFrame from '../components/AvatarWithFrame'
import { FEATURE_FRAMES, FEATURE_AVATARS, FEATURE_AI_UNLIMITED, FEATURE_BADGES } from '../config/featureFlags'
import Footer from '../components/Footer'
import '../styles/frames.css'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

// ── Tier 顯示 ────────────────────────────────────────────────────────
const TIER_META = {
  free:      { label: '免費',   color: 'bg-gray-100 text-gray-600' },
  common:    { label: '普通',   color: 'bg-blue-50 text-blue-700' },
  rare:      { label: '稀有',   color: 'bg-purple-50 text-purple-700' },
  epic:      { label: '史詩',   color: 'bg-amber-50 text-amber-700' },
  legendary: { label: '傳奇',   color: 'bg-pink-50 text-pink-700' },
  limited:   { label: '限定',   color: 'bg-red-50 text-red-600' },
}

async function authHeaders() {
  // Fast path：直接從 localStorage 讀（同步、永不卡）。supabase.auth.getSession()
  // 在某些 OAuth pending / lock 狀態下會永遠不 resolve → 整個 Promise.all 卡住 →
  // 商店「載入中」永遠不解（2026-05-29 實測 catalog 成功但 user/avatars 完全沒發）。
  const { token } = readAuthFromStorage()
  if (token) return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  // Backup：如果 localStorage 沒拿到，給 supabase 3 秒機會（剛 login 還沒寫完 localStorage 的 race）
  try {
    const sessionPromise = supabase?.auth.getSession()
    if (!sessionPromise) return { 'Content-Type': 'application/json' }
    const { data } = await Promise.race([
      sessionPromise,
      new Promise(resolve => setTimeout(() => resolve({}), 3000)),
    ])
    const t = data?.session?.access_token
    if (t) return { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }
  } catch {}
  return { 'Content-Type': 'application/json' }
}

// 強制 bypass cache — 之前發現 catalog API 偶爾 304 + 空 body 讓 r.json() 失敗
const NO_CACHE = { cache: 'no-store' }

// ── 邊框 Tab ──────────────────────────────────────────────────────────
function FramesTab({ coins, onCoinsChange, refreshProfile }) {
  const [catalog, setCatalog] = useState([])
  const [owned, setOwned] = useState(new Set())
  const [equipped, setEquipped] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(null)
  const [msg, setMsg] = useState(null)
  const playerAvatar = usePlayerStore(s => s.avatar) || '👨‍⚕️'

  useEffect(() => {
    Promise.all([
      fetch(`${BACKEND}/api/frames/catalog`, NO_CACHE).then(r => r.json()).catch(() => ({ frames: [] })),
      authHeaders().then(h => fetch(`${BACKEND}/api/user/frames`, { headers: h, cache: 'no-store' }).then(r => r.json()).catch(() => ({ owned: [] }))),
      authHeaders().then(h => fetch(`${BACKEND}/api/profile`, { headers: h, cache: 'no-store' }).then(r => r.json()).catch(() => ({}))),
    ]).then(([cat, my, prof]) => {
      setCatalog(cat.frames || [])
      setOwned(new Set((my.owned || []).map(o => o.frame_id)))
      setEquipped(prof.equipped_frame_id || null)
    }).catch(e => console.error('[frames] load failed', e))
      .finally(() => setLoading(false))
  }, [])

  const buy = async (frame) => {
    setBusy(frame.id); setMsg(null)
    const headers = await authHeaders()
    try {
      const r = await fetch(`${BACKEND}/api/user/frames/purchase`, {
        method: 'POST', headers, body: JSON.stringify({ frame_id: frame.id }),
      })
      const d = await r.json()
      if (!r.ok) {
        if (d.error === 'insufficient_coins') setMsg(`金幣不足，差 ${d.need - d.have} 個`)
        else if (d.error === 'feature_disabled') setMsg('功能尚未開放')
        else setMsg(d.error || '購買失敗')
      } else {
        setOwned(prev => new Set([...prev, frame.id]))
        onCoinsChange(d.coins_left)
        setMsg(`✓ ${frame.name} 解鎖成功`)
      }
    } catch (e) {
      setMsg('連線失敗')
    } finally { setBusy(null) }
  }

  const equip = async (frame_id) => {
    setBusy('equip-' + frame_id)
    const headers = await authHeaders()
    const r = await fetch(`${BACKEND}/api/user/frames/equip`, {
      method: 'POST', headers, body: JSON.stringify({ frame_id }),
    })
    if (r.ok) {
      setEquipped(frame_id === 'none' ? null : frame_id)
      setMsg(`✓ 已裝備：${frame_id === 'none' ? '無邊框' : catalog.find(f => f.id === frame_id)?.name}`)
      refreshProfile?.()
    }
    setBusy(null)
  }

  if (loading) return <div className="text-center py-10 text-gray-400">載入中…</div>

  return (
    <div className="space-y-4">
      {msg && <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs text-amber-800">{msg}</div>}
      <p className="text-xs text-gray-500 leading-relaxed">
        邊框會顯示在排行榜、對戰房間、留言板的頭像周圍。
      </p>
      <div className="grid grid-cols-2 gap-3">
        {catalog.map(f => {
          const isOwned = owned.has(f.id) || f.id === 'none'
          const isEquipped = equipped === f.id || (!equipped && f.id === 'none')
          const tier = TIER_META[f.tier] || TIER_META.common
          return (
            <div key={f.id} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 flex flex-col items-center">
              <span className={`text-[10px] font-bold ${tier.color} px-2 py-0.5 rounded-full mb-2`}>{tier.label}</span>
              <AvatarWithFrame emoji={playerAvatar} frameId={f.id} size="lg" className="mb-2" />
              <p className="text-sm font-bold text-medical-dark text-center">{f.name}</p>
              <div className="mt-2 w-full">
                {isEquipped ? (
                  <div className="text-center text-xs font-bold text-emerald-600 py-2 border-2 border-emerald-200 rounded-xl bg-emerald-50">
                    ✓ 裝備中
                  </div>
                ) : isOwned ? (
                  <button onClick={() => equip(f.id)} disabled={busy} className="w-full py-2 rounded-xl text-xs font-bold text-medical-blue border-2 border-medical-blue active:scale-95 disabled:opacity-50">
                    裝備
                  </button>
                ) : f.price_coins > 0 ? (
                  <button onClick={() => buy(f)} disabled={busy === f.id || coins < f.price_coins}
                    className="w-full py-2 rounded-xl text-xs font-bold text-white grad-cta active:scale-95 disabled:opacity-30">
                    🪙 {f.price_coins.toLocaleString()}
                  </button>
                ) : f.price_ntd > 0 ? (
                  <div className="text-center text-xs text-amber-700 py-2 border-2 border-amber-200 rounded-xl bg-amber-50">
                    NT${f.price_ntd}（請走綠界贊助）
                  </div>
                ) : (
                  <div className="text-center text-xs text-gray-400 py-2">活動限定</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── 頭像 Tab ──────────────────────────────────────────────────────────
function AvatarsTab({ coins, onCoinsChange, refreshProfile }) {
  const [catalog, setCatalog] = useState([])
  const [owned, setOwned] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(null)
  const [msg, setMsg] = useState(null)
  const playerAvatar = usePlayerStore(s => s.avatar) || '👨‍⚕️'

  useEffect(() => {
    Promise.all([
      fetch(`${BACKEND}/api/avatars/catalog`, NO_CACHE).then(r => r.json()).catch(() => ({ avatars: [] })),
      authHeaders().then(h => fetch(`${BACKEND}/api/user/avatars`, { headers: h, cache: 'no-store' }).then(r => r.json()).catch(() => ({ owned: [] }))),
    ]).then(([cat, my]) => {
      setCatalog(cat.avatars || [])
      const ownedSet = new Set((my.owned || []).map(o => o.avatar_id))
      ;(cat.avatars || []).forEach(a => { if (a.tier === 'free') ownedSet.add(a.id) })
      setOwned(ownedSet)
    }).catch(e => console.error('[avatars] load failed', e))
      .finally(() => setLoading(false))
  }, [])

  const buy = async (avatar) => {
    setBusy(avatar.id); setMsg(null)
    const headers = await authHeaders()
    try {
      const r = await fetch(`${BACKEND}/api/user/avatars/purchase`, {
        method: 'POST', headers, body: JSON.stringify({ avatar_id: avatar.id }),
      })
      const d = await r.json()
      if (!r.ok) {
        if (d.error === 'insufficient_coins') setMsg(`金幣不足，差 ${d.need - d.have} 個`)
        else setMsg(d.error || '購買失敗')
      } else {
        setOwned(prev => new Set([...prev, avatar.id]))
        onCoinsChange(d.coins_left)
        setMsg(`✓ ${avatar.name} 解鎖成功`)
      }
    } finally { setBusy(null) }
  }

  const equip = async (avatar) => {
    setBusy('equip-' + avatar.id)
    const headers = await authHeaders()
    const r = await fetch(`${BACKEND}/api/user/avatars/equip`, {
      method: 'POST', headers, body: JSON.stringify({ avatar_id: avatar.id }),
    })
    if (r.ok) {
      // 同步 local store
      usePlayerStore.setState({ avatar: avatar.icon })
      setMsg(`✓ 已套用頭像：${avatar.name}`)
      refreshProfile?.()
    }
    setBusy(null)
  }

  if (loading) return <div className="text-center py-10 text-gray-400">載入中…</div>

  return (
    <div className="space-y-4">
      {msg && <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs text-amber-800">{msg}</div>}
      <p className="text-xs text-gray-500 leading-relaxed">
        頭像會顯示在排行榜、留言板、對戰房間。免費的可直接套用，付費限定的需先解鎖。
      </p>
      <div className="grid grid-cols-3 gap-3">
        {catalog.map(a => {
          const isOwned = owned.has(a.id)
          const isEquipped = playerAvatar === a.icon
          const tier = TIER_META[a.tier] || TIER_META.common
          return (
            <div key={a.id} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-3 flex flex-col items-center">
              {a.is_image ? (
                <img src={a.icon} alt={a.name} className="w-16 h-16 object-contain mb-1" />
              ) : (
                <div className="text-5xl mb-1">{a.icon}</div>
              )}
              <p className="text-[10px] font-bold text-medical-dark text-center mb-1">{a.name}</p>
              <span className={`text-[9px] font-bold ${tier.color} px-1.5 py-0.5 rounded-full mb-2`}>{tier.label}</span>
              {isEquipped ? (
                <div className="text-[10px] text-emerald-600 font-bold">✓ 使用中</div>
              ) : isOwned ? (
                <button onClick={() => equip(a)} disabled={busy} className="text-[10px] px-3 py-1 rounded-lg border border-medical-blue text-medical-blue font-bold">
                  使用
                </button>
              ) : a.price_coins > 0 ? (
                <button onClick={() => buy(a)} disabled={busy === a.id || coins < a.price_coins}
                  className="text-[10px] px-2 py-1 rounded-lg bg-medical-blue text-white font-bold disabled:opacity-30">
                  🪙 {a.price_coins.toLocaleString()}
                </button>
              ) : (
                <div className="text-[10px] text-gray-400">NT${a.price_ntd || '—'}</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── AI 無限 Tab ───────────────────────────────────────────────────────
function AiUnlimitedTab() {
  const [status, setStatus] = useState({ active: false, until: null, packages: {} })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    authHeaders().then(h =>
      fetch(`${BACKEND}/api/ai-unlimited/status`, { headers: h, cache: 'no-store' })
        .then(r => r.json()).catch(() => ({}))
    ).then(d => { setStatus(d) })
      .catch(e => console.error('[ai-unlimited] load failed', e))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="text-center py-10 text-gray-400">載入中…</div>

  const PKGS = [
    { id: '7day',     emoji: '⚡', label: '7 天無限',  desc: '短期衝刺' },
    { id: '30day',    emoji: '🔥', label: '30 天無限', desc: '整月使用最划算' },
    { id: 'lifetime', emoji: '🏆', label: '永久無限',  desc: '一次買斷終身使用' },
  ]

  return (
    <div className="space-y-4">
      {status.active && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl px-4 py-3 text-sm text-emerald-800">
          <p className="font-bold">✓ AI 無限解說 啟用中</p>
          <p className="text-xs mt-1">有效期到：{status.until ? new Date(status.until).toLocaleDateString('zh-TW') : '—'}</p>
        </div>
      )}

      <div className="bg-blue-50 rounded-2xl px-4 py-3 text-xs text-blue-800 leading-relaxed">
        <p className="font-bold mb-2">什麼是 AI 解說無限包？</p>
        <p>原本每題 AI 解說扣 100 金幣（看 1 個廣告賺 300 幣，3 題就用光）。買無限包後，期間內**所有 AI 解說免費**，不再被金幣綁住。</p>
      </div>

      <div className="space-y-3">
        {PKGS.map(p => {
          const pkg = status.packages?.[p.id] || {}
          return (
            <div key={p.id} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
              <div className="flex items-center gap-3 mb-2">
                <span className="text-3xl">{p.emoji}</span>
                <div className="flex-1">
                  <p className="font-bold text-medical-dark">{p.label}</p>
                  <p className="text-xs text-gray-400">{p.desc}</p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-medical-dark text-lg">NT${pkg.ntd || '—'}</p>
                </div>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-[11px] text-amber-700 leading-relaxed">
                ⚠️ 線上付款功能尚未開放。如需購買，請走<a href="https://p.ecpay.com.tw/E11DBDD" target="_blank" rel="noopener noreferrer" className="underline font-bold">綠界贊助</a>對應金額後聯絡客服，會手動開啟無限包。
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── 徽章 Tab ──────────────────────────────────────────────────────────
function BadgesTab({ coins, onCoinsChange, refreshProfile }) {
  const [catalog, setCatalog] = useState([])
  const [owned, setOwned] = useState(new Set())
  const [equipped, setEquipped] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(null)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    Promise.all([
      fetch(`${BACKEND}/api/badges/catalog`, NO_CACHE).then(r => r.json()).catch(() => ({ badges: [] })),
      authHeaders().then(h => fetch(`${BACKEND}/api/user/badges`, { headers: h, cache: 'no-store' }).then(r => r.json()).catch(() => ({ owned: [] }))),
      authHeaders().then(h => fetch(`${BACKEND}/api/profile`, { headers: h, cache: 'no-store' }).then(r => r.json()).catch(() => ({}))),
    ]).then(([cat, my, prof]) => {
      setCatalog(cat.badges || [])
      setOwned(new Set((my.owned || []).map(o => o.badge_id)))
      setEquipped(prof.equipped_badge_id || null)
    }).catch(e => console.error('[badges] load failed', e))
      .finally(() => setLoading(false))
  }, [])

  const buy = async (badge) => {
    setBusy(badge.id); setMsg(null)
    const headers = await authHeaders()
    try {
      const r = await fetch(`${BACKEND}/api/user/badges/purchase`, {
        method: 'POST', headers, body: JSON.stringify({ badge_id: badge.id }),
      })
      const d = await r.json()
      if (!r.ok) {
        if (d.error === 'insufficient_coins') setMsg(`金幣不足，差 ${d.need - d.have} 個`)
        else setMsg(d.error || '購買失敗')
      } else {
        setOwned(prev => new Set([...prev, badge.id]))
        onCoinsChange(d.coins_left)
        setMsg(`✓ ${badge.name} 解鎖成功`)
      }
    } finally { setBusy(null) }
  }

  const equip = async (badge_id) => {
    setBusy('equip-' + badge_id)
    const headers = await authHeaders()
    const r = await fetch(`${BACKEND}/api/user/badges/equip`, {
      method: 'POST', headers, body: JSON.stringify({ badge_id }),
    })
    if (r.ok) {
      setEquipped(badge_id === 'none' ? null : badge_id)
      setMsg(`✓ 已裝備：${badge_id === 'none' ? '無徽章' : catalog.find(b => b.id === badge_id)?.name}`)
      refreshProfile?.()
    }
    setBusy(null)
  }

  if (loading) return <div className="text-center py-10 text-gray-400">載入中…</div>

  return (
    <div className="space-y-4">
      {msg && <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs text-amber-800">{msg}</div>}
      <p className="text-xs text-gray-500 leading-relaxed">
        徽章顯示在排行榜、對戰房間的名字旁，一次只能裝備 1 個。
      </p>
      {equipped && (
        <button onClick={() => equip('none')}
          className="w-full text-xs text-gray-500 underline py-1">
          卸下徽章
        </button>
      )}
      <div className="grid grid-cols-2 gap-3">
        {catalog.map(b => {
          const isOwned = owned.has(b.id)
          const isEquipped = equipped === b.id
          const tier = TIER_META[b.tier] || TIER_META.common
          return (
            <div key={b.id} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-3 flex flex-col items-center">
              <div className="text-4xl mb-1">{b.icon}</div>
              <p className="text-sm font-bold text-medical-dark text-center">{b.name}</p>
              <p className="text-[10px] text-gray-400 text-center mt-0.5 mb-2 leading-tight min-h-[28px]">{b.description}</p>
              <span className={`text-[9px] font-bold ${tier.color} px-1.5 py-0.5 rounded-full mb-2`}>{tier.label}</span>
              {isEquipped ? (
                <div className="w-full text-center text-xs font-bold text-emerald-600 py-1.5 border-2 border-emerald-200 rounded-xl bg-emerald-50">
                  ✓ 裝備中
                </div>
              ) : isOwned ? (
                <button onClick={() => equip(b.id)} disabled={busy} className="w-full py-1.5 rounded-xl text-xs font-bold text-medical-blue border-2 border-medical-blue active:scale-95 disabled:opacity-50">
                  裝備
                </button>
              ) : b.unlock_type === 'coins' && b.price_coins > 0 ? (
                <button onClick={() => buy(b)} disabled={busy === b.id || coins < b.price_coins}
                  className="w-full py-1.5 rounded-xl text-xs font-bold text-white grad-cta active:scale-95 disabled:opacity-30">
                  🪙 {b.price_coins.toLocaleString()}
                </button>
              ) : (
                <div className="text-center text-[11px] text-gray-400 py-1.5">活動限定</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── 主元件 ────────────────────────────────────────────────────────────
export default function Shop() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [coins, setCoins] = useState(usePlayerStore.getState().coins || 0)
  // setCoins action doesn't exist on store — set directly. Backend already
  // deducted; this reflects server's authoritative value (refreshProfile after
  // purchase syncs from cloud as well).
  const setStoreCoins = (c) => usePlayerStore.setState({ coins: c })

  // Tab 由 URL ?tab= 控制
  const allTabs = [
    { id: 'frames',   label: '邊框',     enabled: FEATURE_FRAMES },
    { id: 'avatars',  label: '頭像',     enabled: FEATURE_AVATARS },
    { id: 'badges',   label: '徽章',     enabled: FEATURE_BADGES },
    { id: 'ai',       label: 'AI 無限', enabled: FEATURE_AI_UNLIMITED },
  ].filter(t => t.enabled)

  // 全部 flag OFF → 跳回首頁
  useEffect(() => {
    if (allTabs.length === 0) navigate('/', { replace: true })
  }, [])

  const tab = params.get('tab') || allTabs[0]?.id || 'frames'

  const handleCoinsChange = (newCoins) => {
    setCoins(newCoins)
    setStoreCoins(newCoins)
  }

  const refreshProfile = () => {
    // 觸發 player store reload
    usePlayerStore.getState().hydrateFromCloud?.(true).catch(() => {})
  }

  if (allTabs.length === 0) return null

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      {/* Header */}
      <div className="grad-header px-4 pt-5 pb-4">
        <button onClick={() => navigate('/')} className="text-white/80 text-sm mb-2 active:opacity-70">‹ 返回</button>
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-white">🛒 商店</h1>
          <div className="bg-white/15 px-3 py-1 rounded-full">
            <span className="text-amber-300 text-sm font-bold">🪙 {coins.toLocaleString()}</span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white border-b border-gray-100 flex">
        {allTabs.map(t => (
          <button key={t.id} onClick={() => setParams({ tab: t.id }, { replace: true })}
            className={`flex-1 py-3 text-sm font-bold border-b-2 transition-colors ${
              tab === t.id ? 'text-medical-blue border-medical-blue' : 'text-gray-400 border-transparent'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 p-4">
        {tab === 'frames' && FEATURE_FRAMES && (
          <FramesTab coins={coins} onCoinsChange={handleCoinsChange} refreshProfile={refreshProfile} />
        )}
        {tab === 'avatars' && FEATURE_AVATARS && (
          <AvatarsTab coins={coins} onCoinsChange={handleCoinsChange} refreshProfile={refreshProfile} />
        )}
        {tab === 'badges' && FEATURE_BADGES && (
          <BadgesTab coins={coins} onCoinsChange={handleCoinsChange} refreshProfile={refreshProfile} />
        )}
        {tab === 'ai' && FEATURE_AI_UNLIMITED && (
          <AiUnlimitedTab />
        )}
      </div>

      <Footer />
    </div>
  )
}
