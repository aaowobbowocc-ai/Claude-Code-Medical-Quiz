import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/gameStore'
import { getSocket } from '../hooks/useSocket'

const AVATARS = ['👨‍⚕️','👩‍⚕️','🧑‍⚕️','👨‍🔬','👩‍🔬','🧬','🩺','💉']

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

export default function Home() {
  const navigate = useNavigate()
  const { name, setName, coins, level } = usePlayerStore()
  const av = usePlayerStore(s => s.avatar) || '👨‍⚕️'
  const setAvatar = usePlayerStore(s => s.setAvatar)
  const socket = getSocket()

  const [sheet, setSheet]         = useState(null)   // null | 'editname' | 'join'
  const [inputName, setInputName] = useState('')
  const [joinCode, setJoinCode]   = useState('')
  const [joinError, setJoinError] = useState('')
  const [connecting, setConnecting] = useState(false)

  // Quick-name: inline input shown only when no name
  const [quickName, setQuickName] = useState('')
  const quickRef = useRef(null)

  useEffect(() => {
    const s = socket
    const onErr = ({ message }) => { setJoinError(message); setConnecting(false) }
    s.on('error', onErr)
    return () => s.off('error', onErr)
  }, [socket])

  // ── Actions ────────────────────────────────────────────────
  const doCreate = (nameToUse) => {
    setConnecting(true)
    socket.connect()
    socket.emit('create_room', { playerName: nameToUse })
  }

  const doJoin = (nameToUse) => {
    if (!joinCode.trim()) { setJoinError('請輸入邀請碼'); return }
    setConnecting(true)
    setJoinError('')
    socket.connect()
    socket.emit('join_room', { code: joinCode.trim().toUpperCase(), playerName: nameToUse })
  }

  const handleCreate = () => {
    if (name) { doCreate(name); return }
    if (quickName.trim()) { setName(quickName.trim()); doCreate(quickName.trim()); return }
    quickRef.current?.focus()
  }

  const handleJoin = () => {
    if (name) { doJoin(name); return }
    if (quickName.trim()) { setName(quickName.trim()); doJoin(quickName.trim()); return }
    quickRef.current?.focus()
  }

  const handleSaveEdit = () => {
    if (!inputName.trim()) return
    setName(inputName.trim())
    setSheet(null)
  }

  const expPct = Math.min(((usePlayerStore.getState().exp || 0) / 300) * 100, 100)

  // ── No-name: inline quick-start ──────────────────────────
  if (!name) {
    return (
      <div className="flex flex-col min-h-dvh no-select" style={{ background: '#F0F4F8' }}>
        <div className="relative overflow-hidden px-5 pt-14 pb-10 flex flex-col items-center"
             style={{ background: 'linear-gradient(160deg, #0F2A3F 0%, #1A6B9A 60%, #0D9488 100%)' }}>
          {[...Array(6)].map((_, i) => (
            <div key={i} className="absolute text-white/5 font-bold text-7xl select-none"
                 style={{ top: `${10 + i * 28}%`, left: `${-5 + (i % 3) * 40}%` }}>✚</div>
          ))}
          <div className="relative text-6xl mb-3">⚕️</div>
          <h1 className="relative text-white font-bold text-3xl tracking-tight mb-1">醫師知識王</h1>
          <p className="relative text-white/50 text-sm">醫師國考一階 · 即時對戰</p>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center px-6 gap-4 -mt-6">
          {/* Avatar row */}
          <div className="flex gap-2 mb-1">
            {AVATARS.map(a => (
              <button key={a} onClick={() => setAvatar?.(a)}
                      className={`w-11 h-11 rounded-xl text-2xl flex items-center justify-center transition-all active:scale-90
                        ${av === a ? 'bg-medical-blue scale-105 shadow' : 'bg-white shadow-sm'}`}>
                {a}
              </button>
            ))}
          </div>

          {/* Name input — inline, no modal */}
          <div className="w-full max-w-xs">
            <input
              ref={quickRef}
              autoFocus
              className="w-full border-2 border-medical-blue rounded-2xl px-4 py-4 text-xl text-center outline-none focus:border-medical-accent font-medium bg-white shadow-sm"
              placeholder="輸入你的名字"
              value={quickName}
              onChange={e => setQuickName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && quickName.trim() && (setName(quickName.trim()))}
              maxLength={12}
            />
          </div>

          <div className="w-full max-w-xs flex flex-col gap-3 mt-1">
            <button
              onClick={handleCreate}
              disabled={connecting}
              className="w-full py-4 rounded-2xl font-bold text-lg text-white active:scale-95 transition-transform disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, #1A6B9A, #0D9488)' }}
            >
              🏠 建立房間
            </button>
            <button
              onClick={() => setSheet('join')}
              className="w-full py-4 rounded-2xl font-bold text-lg bg-white text-medical-blue border-2 border-medical-blue active:scale-95 transition-transform"
            >
              🔗 加入房間
            </button>
          </div>

          <div className="flex gap-3 w-full max-w-xs mt-1">
            {[['🎯','練習','/practice'],['📖','題庫','/browse'],['🗺️','地圖','/map']].map(([icon,lbl,path]) => (
              <button key={path} onClick={() => navigate(path)}
                      className="flex-1 bg-white rounded-2xl py-3 flex flex-col items-center gap-1 shadow-sm border border-gray-100 active:scale-95">
                <span className="text-xl">{icon}</span>
                <span className="text-xs text-gray-500 font-medium">{lbl}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Join sheet */}
        {sheet === 'join' && (
          <Sheet onClose={() => { setSheet(null); setJoinError(''); setJoinCode('') }}>
            <h2 className="text-xl font-bold text-medical-dark text-center mb-2">加入房間</h2>
            <p className="text-center text-gray-400 text-sm mb-4">輸入好友的 6 碼邀請碼</p>
            <input
              autoFocus
              className="w-full border-2 border-medical-teal rounded-2xl px-4 py-4 text-3xl text-center font-mono tracking-[0.3em] outline-none focus:border-medical-accent mb-2 uppercase"
              placeholder="XXXXXX" value={joinCode}
              onChange={e => { setJoinCode(e.target.value.toUpperCase()); setJoinError('') }}
              maxLength={6}
            />
            {joinError && <p className="text-medical-danger text-sm text-center mb-2 animate-shake">{joinError}</p>}
            <button onClick={handleJoin} disabled={connecting || joinCode.length < 6}
                    className="w-full py-4 rounded-2xl font-bold text-lg text-white mt-2 active:scale-95 transition-transform disabled:opacity-50"
                    style={{ background: 'linear-gradient(135deg, #0D9488, #1A6B9A)' }}>
              {connecting ? '連線中...' : '加入'}
            </button>
          </Sheet>
        )}
      </div>
    )
  }

  // ── Has name: instant home ───────────────────────────────
  return (
    <div className="flex flex-col min-h-dvh no-select" style={{ background: '#F0F4F8' }}>

      {/* Hero */}
      <div className="relative overflow-hidden px-5 pt-14 pb-6"
           style={{ background: 'linear-gradient(160deg, #0F2A3F 0%, #1A6B9A 60%, #0D9488 100%)' }}>
        {[...Array(6)].map((_, i) => (
          <div key={i} className="absolute text-white/5 font-bold text-7xl select-none"
               style={{ top: `${10 + i * 28}%`, left: `${-5 + (i % 3) * 40}%` }}>✚</div>
        ))}

        {/* Title + profile */}
        <div className="relative flex items-center justify-between mb-4">
          <div>
            <p className="text-white/50 text-xs font-medium tracking-widest uppercase mb-0.5">醫師一階</p>
            <h1 className="text-white font-bold text-3xl tracking-tight leading-none">知識王</h1>
          </div>
          {/* Avatar — tap to edit name */}
          <button onClick={() => { setInputName(name); setSheet('editname') }}
                  className="relative w-14 h-14 rounded-2xl bg-white/15 border border-white/20 flex items-center justify-center text-3xl active:scale-90 transition-transform shadow-lg">
            {av}
            <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-white/20 border border-white/30 flex items-center justify-center">
              <span className="text-white text-xs">✎</span>
            </div>
          </button>
        </div>

        {/* Profile card */}
        <div className="relative bg-white/10 border border-white/15 rounded-2xl px-4 py-3.5">
          <div className="flex items-center gap-3 mb-2.5">
            <span className="text-3xl">{av}</span>
            <div className="flex-1">
              <p className="text-white font-bold text-xl leading-tight">{name}</p>
              <p className="text-white/40 text-xs">Lv.{level} 醫師學徒</p>
            </div>
            <div className="text-right">
              <p className="text-white/40 text-xs">金幣</p>
              <p className="text-white font-bold text-lg">🪙 {coins}</p>
            </div>
          </div>
          <div className="w-full h-1.5 bg-white/20 rounded-full">
            <div className="h-full bg-white/70 rounded-full transition-all duration-500" style={{ width: `${expPct}%` }} />
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex-1 px-4 pt-4 pb-8 flex flex-col gap-3">
        <button onClick={handleCreate} disabled={connecting}
                className="w-full rounded-2xl py-5 flex items-center px-5 gap-4 shadow-lg active:scale-[0.97] transition-transform disabled:opacity-60"
                style={{ background: 'linear-gradient(135deg, #1A6B9A, #0D9488)' }}>
          <div className="w-12 h-12 rounded-xl bg-white/20 flex items-center justify-center text-2xl shrink-0">🏠</div>
          <div className="text-left flex-1">
            <p className="text-white font-bold text-xl leading-tight">建立房間</p>
            <p className="text-white/60 text-xs mt-0.5">邀請好友一起對戰</p>
          </div>
          <div className="text-white/50 text-xl">›</div>
        </button>

        <button onClick={() => setSheet('join')}
                className="w-full rounded-2xl py-5 flex items-center px-5 gap-4 bg-white shadow-sm border border-gray-100 active:scale-[0.97] transition-transform">
          <div className="w-12 h-12 rounded-xl bg-medical-light flex items-center justify-center text-2xl shrink-0">🔗</div>
          <div className="text-left flex-1">
            <p className="text-medical-dark font-bold text-xl leading-tight">加入房間</p>
            <p className="text-gray-400 text-xs mt-0.5">輸入好友的邀請碼</p>
          </div>
          <div className="text-gray-300 text-xl">›</div>
        </button>

        <div className="flex items-center gap-3 my-0.5">
          <div className="flex-1 h-px bg-gray-200" />
          <span className="text-gray-400 text-xs">單人模式</span>
          <div className="flex-1 h-px bg-gray-200" />
        </div>

        <div className="flex gap-3">
          {[['🎯','自主練習','練習含AI對手','/practice'],
            ['📖','題庫瀏覽','依年份科目','/browse'],
            ['🗺️','關卡地圖','9 個科目','/map']].map(([icon,title,sub,path]) => (
            <button key={path} onClick={() => navigate(path)}
                    className="flex-1 rounded-2xl py-4 flex flex-col items-center gap-1.5 bg-white shadow-sm border border-gray-100 active:scale-[0.97] transition-transform">
              <div className="w-11 h-11 rounded-xl bg-medical-ice flex items-center justify-center text-2xl">{icon}</div>
              <p className="text-medical-dark font-bold text-xs">{title}</p>
              <p className="text-gray-400 text-xs">{sub}</p>
            </button>
          ))}
        </div>

        <div className="flex gap-3 mt-1">
          {[{ icon:'📚', val:'1396', lbl:'題目' },{ icon:'📅', val:'110–113', lbl:'年份' },{ icon:'🔬', val:'9', lbl:'科目' }]
            .map(s => (
            <div key={s.lbl} className="flex-1 bg-white rounded-2xl py-3 flex flex-col items-center shadow-sm border border-gray-100">
              <span className="text-xl">{s.icon}</span>
              <span className="font-bold text-medical-dark text-sm">{s.val}</span>
              <span className="text-gray-400 text-xs">{s.lbl}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Sheet: edit name */}
      {sheet === 'editname' && (
        <Sheet onClose={() => setSheet(null)}>
          <h2 className="text-xl font-bold text-medical-dark text-center mb-4">修改名字</h2>
          <div className="grid grid-cols-4 gap-2 mb-4">
            {AVATARS.map(a => (
              <button key={a} onClick={() => setAvatar?.(a)}
                      className={`h-14 rounded-xl text-3xl flex items-center justify-center transition-all active:scale-90
                        ${av === a ? 'bg-medical-blue scale-105 shadow-md' : 'bg-medical-ice'}`}>
                {a}
              </button>
            ))}
          </div>
          <input autoFocus
                 className="w-full border-2 border-medical-blue rounded-xl px-4 py-3.5 text-lg text-center outline-none focus:border-medical-accent mb-4 font-medium"
                 value={inputName} onChange={e => setInputName(e.target.value)}
                 onKeyDown={e => e.key === 'Enter' && handleSaveEdit()}
                 maxLength={12} />
          <button onClick={handleSaveEdit}
                  className="w-full py-4 rounded-2xl font-bold text-lg text-white active:scale-95 transition-transform"
                  style={{ background: 'linear-gradient(135deg, #1A6B9A, #0D9488)' }}>
            儲存
          </button>
        </Sheet>
      )}

      {/* Sheet: join room */}
      {sheet === 'join' && (
        <Sheet onClose={() => { setSheet(null); setJoinError(''); setJoinCode('') }}>
          <h2 className="text-xl font-bold text-medical-dark text-center mb-2">加入房間</h2>
          <p className="text-center text-gray-400 text-sm mb-4">輸入好友的 6 碼邀請碼</p>
          <input autoFocus
                 className="w-full border-2 border-medical-teal rounded-2xl px-4 py-4 text-3xl text-center font-mono tracking-[0.3em] outline-none focus:border-medical-accent mb-2 uppercase"
                 placeholder="XXXXXX" value={joinCode}
                 onChange={e => { setJoinCode(e.target.value.toUpperCase()); setJoinError('') }}
                 maxLength={6} />
          {joinError && <p className="text-medical-danger text-sm text-center mb-2 animate-shake">{joinError}</p>}
          <button onClick={handleJoin} disabled={connecting || joinCode.length < 6}
                  className="w-full py-4 rounded-2xl font-bold text-lg text-white mt-2 active:scale-95 transition-transform disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg, #0D9488, #1A6B9A)' }}>
            {connecting ? '連線中...' : '加入'}
          </button>
        </Sheet>
      )}
    </div>
  )
}
