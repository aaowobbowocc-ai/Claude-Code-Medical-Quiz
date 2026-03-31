import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/gameStore'
import { getSocket } from '../hooks/useSocket'

/* ── Avatar options ─────────────────────────────────────────── */
const AVATARS = ['👨‍⚕️','👩‍⚕️','🧑‍⚕️','👨‍🔬','👩‍🔬','🧬','🩺','💉']

/* ── Bottom Sheet wrapper ───────────────────────────────────── */
function Sheet({ onClose, children }) {
  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div className="sheet-panel" onClick={e => e.stopPropagation()}>
        <div className="sheet-handle" />
        {children}
      </div>
    </div>
  )
}

/* ── Stat chip ──────────────────────────────────────────────── */
function Stat({ icon, value, label }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="text-lg">{icon}</span>
      <span className="font-bold text-white text-base leading-none">{value}</span>
      <span className="text-white/50 text-xs">{label}</span>
    </div>
  )
}

export default function Home() {
  const navigate = useNavigate()
  const { name, setName, coins, level, avatar = '👨‍⚕️', setAvatar } = usePlayerStore()
  const socket = getSocket()

  const [sheet, setSheet] = useState(null) // null | 'profile' | 'join'
  const [inputName, setInputName] = useState(name)
  const [joinCode, setJoinCode] = useState('')
  const [joinError, setJoinError] = useState('')
  const [connecting, setConnecting] = useState(false)

  // Show profile sheet on first open if no name
  useEffect(() => {
    if (!name) setSheet('profile')
  }, [])

  // Socket error listener
  useEffect(() => {
    const s = socket
    const onErr = ({ message }) => { setJoinError(message); setConnecting(false) }
    s.on('error', onErr)
    return () => s.off('error', onErr)
  }, [socket])

  const handleCreate = () => {
    if (!name) { setSheet('profile'); return }
    setConnecting(true)
    socket.connect()
    socket.emit('create_room', { playerName: name })
  }

  const handleJoin = () => {
    if (!joinCode.trim()) { setJoinError('請輸入邀請碼'); return }
    if (!name) { setSheet('profile'); return }
    setConnecting(true)
    setJoinError('')
    socket.connect()
    socket.emit('join_room', { code: joinCode.trim().toUpperCase(), playerName: name })
  }

  const handleSaveName = () => {
    if (!inputName.trim()) return
    setName(inputName.trim())
    setSheet(null)
  }

  const expPct = Math.min(((usePlayerStore.getState().exp || 0) / 300) * 100, 100)

  return (
    <div className="flex flex-col min-h-dvh no-select" style={{ background: '#F0F4F8' }}>

      {/* ── Hero section ──────────────────────────────────────── */}
      <div className="relative overflow-hidden px-5 pt-14 pb-8"
           style={{ background: 'linear-gradient(160deg, #0F2A3F 0%, #1A6B9A 60%, #0D9488 100%)' }}>

        {/* Decorative medical cross pattern */}
        <div className="absolute inset-0 pointer-events-none select-none overflow-hidden">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="absolute text-white/5 font-bold text-7xl"
                 style={{ top: `${10 + i * 28}%`, left: `${-5 + (i % 3) * 40}%` }}>✚</div>
          ))}
        </div>

        {/* Title row */}
        <div className="relative flex items-center justify-between mb-6">
          <div>
            <p className="text-white/60 text-xs font-medium tracking-widest uppercase mb-1">醫師一階</p>
            <h1 className="text-white font-bold text-3xl tracking-tight leading-none">知識王</h1>
          </div>
          {/* Profile tap */}
          <button
            onClick={() => setSheet('profile')}
            className="relative w-14 h-14 rounded-2xl bg-white/15 backdrop-blur border border-white/20 flex items-center justify-center text-3xl active:scale-90 transition-transform shadow-lg"
          >
            {name ? (usePlayerStore.getState().avatar || '👨‍⚕️') : '👤'}
            <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-medical-teal flex items-center justify-center">
              <span className="text-white text-xs font-bold">{level}</span>
            </div>
          </button>
        </div>

        {/* Profile card */}
        {name ? (
          <div className="relative bg-white/10 backdrop-blur rounded-2xl border border-white/15 px-5 py-4">
            <div className="flex items-center gap-4 mb-3">
              <span className="text-4xl">{usePlayerStore.getState().avatar || '👨‍⚕️'}</span>
              <div className="flex-1">
                <p className="text-white font-bold text-xl leading-tight">{name}</p>
                <p className="text-white/50 text-xs">Lv.{level} 醫師學徒</p>
              </div>
              <div className="text-right">
                <p className="text-white/50 text-xs">金幣</p>
                <p className="text-white font-bold text-xl">🪙 {coins}</p>
              </div>
            </div>
            {/* EXP bar */}
            <div className="w-full h-1.5 bg-white/20 rounded-full">
              <div className="h-full bg-medical-teal rounded-full transition-all duration-500"
                   style={{ width: `${expPct}%` }} />
            </div>
          </div>
        ) : (
          <button
            onClick={() => setSheet('profile')}
            className="relative w-full bg-white/10 border-2 border-dashed border-white/30 rounded-2xl px-5 py-5 text-white/60 text-center active:bg-white/20 transition-colors"
          >
            點此設定你的名字 →
          </button>
        )}
      </div>

      {/* ── Action area ────────────────────────────────────────── */}
      <div className="flex-1 px-4 pt-5 pb-8 flex flex-col gap-3">

        {/* Create room — primary CTA */}
        <button
          onClick={handleCreate}
          disabled={connecting}
          className="w-full rounded-2xl py-5 flex items-center px-5 gap-4 shadow-lg active:scale-[0.97] transition-transform disabled:opacity-60"
          style={{ background: 'linear-gradient(135deg, #1A6B9A, #0D9488)' }}
        >
          <div className="w-12 h-12 rounded-xl bg-white/20 flex items-center justify-center text-2xl shrink-0">
            🏠
          </div>
          <div className="text-left flex-1">
            <p className="text-white font-bold text-xl leading-tight">建立房間</p>
            <p className="text-white/60 text-xs mt-0.5">邀請好友一起對戰</p>
          </div>
          <div className="text-white/50 text-xl">›</div>
        </button>

        {/* Join room */}
        <button
          onClick={() => setSheet('join')}
          className="w-full rounded-2xl py-5 flex items-center px-5 gap-4 bg-white shadow-sm border border-gray-100 active:scale-[0.97] transition-transform"
        >
          <div className="w-12 h-12 rounded-xl bg-medical-light flex items-center justify-center text-2xl shrink-0">
            🔗
          </div>
          <div className="text-left flex-1">
            <p className="text-medical-dark font-bold text-xl leading-tight">加入房間</p>
            <p className="text-gray-400 text-xs mt-0.5">輸入好友的邀請碼</p>
          </div>
          <div className="text-gray-300 text-xl">›</div>
        </button>

        {/* Divider */}
        <div className="flex items-center gap-3 my-1">
          <div className="flex-1 h-px bg-gray-200" />
          <span className="text-gray-400 text-xs">單人模式</span>
          <div className="flex-1 h-px bg-gray-200" />
        </div>

        {/* Solo buttons row */}
        <div className="flex gap-3">
          {/* Practice */}
          <button
            onClick={() => navigate('/practice')}
            className="flex-1 rounded-2xl py-4 flex flex-col items-center gap-1.5 bg-white shadow-sm border border-gray-100 active:scale-[0.97] transition-transform"
          >
            <div className="w-11 h-11 rounded-xl bg-purple-50 flex items-center justify-center text-2xl">🎯</div>
            <p className="text-medical-dark font-bold text-sm">自主練習</p>
            <p className="text-gray-400 text-xs">含 AI 對手</p>
          </button>

          {/* Browse */}
          <button
            onClick={() => navigate('/browse')}
            className="flex-1 rounded-2xl py-4 flex flex-col items-center gap-1.5 bg-white shadow-sm border border-gray-100 active:scale-[0.97] transition-transform"
          >
            <div className="w-11 h-11 rounded-xl bg-amber-50 flex items-center justify-center text-2xl">📖</div>
            <p className="text-medical-dark font-bold text-sm">題庫瀏覽</p>
            <p className="text-gray-400 text-xs">依年份科目</p>
          </button>

          {/* Map */}
          <button
            onClick={() => navigate('/map')}
            className="flex-1 rounded-2xl py-4 flex flex-col items-center gap-1.5 bg-white shadow-sm border border-gray-100 active:scale-[0.97] transition-transform"
          >
            <div className="w-11 h-11 rounded-xl bg-teal-50 flex items-center justify-center text-2xl">🗺️</div>
            <p className="text-medical-dark font-bold text-sm">關卡地圖</p>
            <p className="text-gray-400 text-xs">9 個科目</p>
          </button>
        </div>

        {/* Stats row */}
        <div className="flex gap-3 mt-1">
          {[
            { icon: '📚', val: '1396', lbl: '題目' },
            { icon: '📅', val: '110–113', lbl: '年份' },
            { icon: '🔬', val: '9', lbl: '科目' },
          ].map(s => (
            <div key={s.lbl} className="flex-1 bg-white rounded-2xl py-3 flex flex-col items-center shadow-sm border border-gray-100">
              <span className="text-xl">{s.icon}</span>
              <span className="font-bold text-medical-dark text-sm">{s.val}</span>
              <span className="text-gray-400 text-xs">{s.lbl}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Sheet: Profile ─────────────────────────────────────── */}
      {sheet === 'profile' && (
        <Sheet onClose={() => name && setSheet(null)}>
          <h2 className="text-xl font-bold text-medical-dark text-center mb-5">設定個人資料</h2>

          {/* Avatar picker */}
          <p className="text-xs text-gray-400 font-medium mb-2">選擇頭像</p>
          <div className="grid grid-cols-4 gap-2 mb-5">
            {AVATARS.map(av => (
              <button
                key={av}
                onClick={() => usePlayerStore.getState().setAvatar?.(av)}
                className={`h-14 rounded-xl text-3xl flex items-center justify-center transition-all active:scale-90
                  ${(usePlayerStore.getState().avatar || '👨‍⚕️') === av
                    ? 'bg-medical-blue scale-105 shadow-md'
                    : 'bg-medical-ice'}`}
              >
                {av}
              </button>
            ))}
          </div>

          {/* Name input */}
          <p className="text-xs text-gray-400 font-medium mb-2">名字</p>
          <input
            autoFocus
            className="w-full border-2 border-medical-blue rounded-xl px-4 py-3.5 text-lg text-center outline-none focus:border-medical-accent mb-4 font-medium"
            placeholder="輸入你的名字"
            value={inputName}
            onChange={e => setInputName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSaveName()}
            maxLength={12}
          />
          <button
            onClick={handleSaveName}
            className="w-full py-4 rounded-2xl font-bold text-lg text-white active:scale-95 transition-transform"
            style={{ background: 'linear-gradient(135deg, #1A6B9A, #0D9488)' }}
          >
            儲存
          </button>
        </Sheet>
      )}

      {/* ── Sheet: Join room ───────────────────────────────────── */}
      {sheet === 'join' && (
        <Sheet onClose={() => { setSheet(null); setJoinError(''); setJoinCode('') }}>
          <h2 className="text-xl font-bold text-medical-dark text-center mb-2">加入房間</h2>
          <p className="text-center text-gray-400 text-sm mb-5">輸入好友的 6 碼邀請碼</p>

          <input
            autoFocus
            className="w-full border-2 border-medical-teal rounded-2xl px-4 py-4 text-3xl text-center font-mono tracking-[0.3em] outline-none focus:border-medical-accent mb-2 uppercase"
            placeholder="XXXXXX"
            value={joinCode}
            onChange={e => { setJoinCode(e.target.value.toUpperCase()); setJoinError('') }}
            onKeyDown={e => e.key === 'Enter' && handleJoin()}
            maxLength={6}
          />

          {joinError && (
            <p className="text-medical-danger text-sm text-center mb-3 animate-shake">{joinError}</p>
          )}

          <button
            onClick={handleJoin}
            disabled={connecting || joinCode.length < 6}
            className="w-full py-4 rounded-2xl font-bold text-lg text-white mt-3 active:scale-95 transition-transform disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg, #0D9488, #1A6B9A)' }}
          >
            {connecting ? '連線中...' : '加入'}
          </button>
        </Sheet>
      )}
    </div>
  )
}
