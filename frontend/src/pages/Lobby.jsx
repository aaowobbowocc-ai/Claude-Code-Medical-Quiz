import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useGameStore, usePlayerStore } from '../store/gameStore'
import { getSocket } from '../hooks/useSocket'
import ConnectionStatus from '../components/ConnectionStatus'

const STAGES = [
  { id: 0, name: '隨機混合',   icon: '🎲', color: '#64748B', count: 2000 },
  { id: 1, name: '解剖學殿堂', icon: '🦴', color: '#3B82F6', count: 335  },
  { id: 2, name: '生理學之谷', icon: '💓', color: '#EF4444', count: 269  },
  { id: 3, name: '生化迷宮',   icon: '⚗️',  color: '#8B5CF6', count: 261  },
  { id: 4, name: '組織學祕境', icon: '🔬', color: '#6366F1', count: 107  },
  { id: 10,name: '胚胎學源脈', icon: '🧬', color: '#818CF8', count: 28   },
  { id: 5, name: '微免聖域',   icon: '🦠', color: '#10B981', count: 316  },
  { id: 6, name: '寄生蟲荒原', icon: '🪱', color: '#D97706', count: 53   },
  { id: 7, name: '藥理決鬥場', icon: '💊', color: '#F97316', count: 281  },
  { id: 8, name: '病理學深淵', icon: '🩺', color: '#DC2626', count: 216  },
  { id: 9, name: '公衛學巔峰', icon: '📊', color: '#0D9488', count: 134  },
]

/* Pulsing dot animation for "waiting" */
function PulseDot() {
  return (
    <span className="inline-flex gap-1">
      {[0,1,2].map(i => (
        <span key={i} className="w-1.5 h-1.5 rounded-full bg-medical-blue inline-block animate-bounce"
              style={{ animationDelay: `${i * 0.15}s` }} />
      ))}
    </span>
  )
}

export default function Lobby() {
  const navigate = useNavigate()
  const socket = getSocket()
  const { roomCode, isHost, players, stage, timerMode } = useGameStore()
  const { name } = usePlayerStore()
  const [copied, setCopied] = useState(false)   // share msg
  const [codeCopied, setCodeCopied] = useState(false) // code only
  const [showStages, setShowStages] = useState(false)
  const [showAIDiff, setShowAIDiff] = useState(false)
  const [customSec, setCustomSec] = useState('')

  useEffect(() => { if (!roomCode) navigate('/') }, [roomCode])

  const selectedStage = STAGES.find(s => s.id === stage) || STAGES[0]

  const handleCopyCode = async () => {
    await navigator.clipboard?.writeText(roomCode).catch(() => {})
    setCodeCopied(true)
    setTimeout(() => setCodeCopied(false), 2000)
  }

  const handleShare = async () => {
    const msg = `我在玩「醫學知識王」，邀請碼：${roomCode}，快來挑戰我！`
    if (navigator.share) {
      try { await navigator.share({ title: '醫學知識王', text: msg }); return } catch {}
    }
    await navigator.clipboard?.writeText(msg).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleStart = () => socket.emit('start_game')
  const handleStageChange = (id) => { socket.emit('select_stage', { stageId: id }); setShowStages(false) }
  const handleAddAI = (diff) => { socket.emit('add_ai_player', { difficulty: diff }); setShowAIDiff(false) }
  const handleRemoveAI = () => socket.emit('remove_ai_player')
  const handleTimerMode = (mode) => socket.emit('set_timer_mode', { mode })

  const avatarOf = (p) => p.avatar || '👨‍⚕️'
  const hasAI = players.some(p => p.isAI)

  return (
    <div className="flex flex-col min-h-dvh no-select bg-medical-ice">
      <ConnectionStatus />

      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="relative overflow-hidden px-5 pt-14 pb-6 grad-header">
        {/* BG cross */}
        <div className="absolute inset-0 pointer-events-none select-none overflow-hidden">
          {[...Array(4)].map((_,i) => (
            <div key={i} className="absolute text-white/5 font-bold text-7xl"
                 style={{ top:`${15+i*30}%`, right:`${5+i*20}%` }}>✚</div>
          ))}
        </div>

        <button onClick={() => { socket.disconnect(); navigate('/') }}
                className="text-white/50 text-sm mb-4 relative inline-flex items-center gap-1">
          ‹ 返回主畫面
        </button>

        <p className="text-white/50 text-xs uppercase tracking-widest font-medium relative">
          {isHost ? '房間已建立' : '已加入房間'}
        </p>

        {/* Room code — tap to copy */}
        <button onClick={handleCopyCode} className="relative mt-1 mb-3 active:scale-95 transition-transform">
          <div className="flex gap-2.5">
            {roomCode?.split('').map((ch, i) => (
              <div key={i}
                   className="w-10 h-12 rounded-xl bg-white/15 border border-white/20 flex items-center justify-center text-white font-mono font-bold text-2xl backdrop-blur">
                {ch}
              </div>
            ))}
          </div>
          <p className={`text-xs mt-1.5 text-center transition-all ${codeCopied ? 'text-medical-teal font-semibold' : 'text-white/40'}`}>
            {codeCopied ? '✓ 邀請碼已複製' : '點擊複製邀請碼'}
          </p>
        </button>

        {/* Share buttons */}
        <div className="flex gap-2 relative">
          <button
            onClick={handleCopyCode}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all active:scale-95
              ${codeCopied ? 'bg-medical-teal text-white' : 'bg-white/15 text-white border border-white/20'}`}
          >
            <span>{codeCopied ? '✓ 已複製' : '📋 複製邀請碼'}</span>
          </button>
          <button
            onClick={handleShare}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all active:scale-95
              ${copied ? 'bg-medical-teal text-white' : 'bg-white/15 text-white border border-white/20'}`}
          >
            <span>{copied ? '✓ 已分享' : '📤 分享給好友'}</span>
          </button>
        </div>
      </div>

      {/* ── Players ─────────────────────────────────────────────── */}
      <div className="px-4 mt-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest">玩家</p>
          <p className="text-xs text-gray-400">{players.length} / 4</p>
        </div>

        <div className="flex flex-col gap-2.5">
          {players.map((p, i) => (
            <div key={p.id}
                 className="bg-white rounded-2xl px-4 py-3.5 flex items-center gap-3 shadow-sm border border-gray-100">
              <div className="w-12 h-12 rounded-xl bg-medical-ice flex items-center justify-center text-2xl">
                {avatarOf(p)}
              </div>
              <div className="flex-1">
                <p className="font-bold text-medical-dark text-base">{p.name}</p>
                <p className="text-gray-400 text-xs">{i === 0 ? '房主' : '玩家'}</p>
              </div>
              {i === 0 && !p.isAI && (
                <span className="text-xs bg-medical-gold text-white px-2.5 py-1 rounded-full font-semibold">
                  👑 房主
                </span>
              )}
              {p.isAI && (
                <span className="text-xs bg-violet-500 text-white px-2.5 py-1 rounded-full font-semibold">
                  🤖 AI
                </span>
              )}
            </div>
          ))}

          {/* Empty slot — show AI invite for host when no AI yet */}
          {players.length < 4 && (
            <div className="bg-white rounded-2xl px-4 py-3.5 flex items-center gap-3 border-2 border-dashed border-gray-200">
              <div className="w-12 h-12 rounded-xl bg-gray-50 flex items-center justify-center">
                <PulseDot />
              </div>
              <p className="text-gray-400 text-sm flex-1">等待對手加入...</p>
              {isHost && !hasAI && (
                <button
                  onClick={() => setShowAIDiff(v => !v)}
                  className="text-xs font-semibold px-3 py-1.5 rounded-xl text-white active:scale-95 transition-transform"
                  style={{ background: 'linear-gradient(135deg, #6366F1, #8B5CF6)' }}
                >
                  🤖 AI 陪練
                </button>
              )}
            </div>
          )}

          {/* AI difficulty picker */}
          {isHost && showAIDiff && (
            <div className="flex gap-2">
              {[['easy','簡單','#10B981'],['normal','普通','#F97316'],['hard','困難','#EF4444']].map(([diff,label,color]) => (
                <button key={diff} onClick={() => handleAddAI(diff)}
                        className="flex-1 py-3 rounded-2xl text-white text-sm font-bold active:scale-95 transition-transform"
                        style={{ background: color }}>
                  {label}
                </button>
              ))}
            </div>
          )}

          {/* Remove AI button */}
          {isHost && hasAI && (
            <button onClick={handleRemoveAI}
                    className="text-xs text-gray-400 text-center w-full py-1 active:opacity-70">
              移除 AI 對手
            </button>
          )}
        </div>
      </div>

      {/* ── Stage selector ──────────────────────────────────────── */}
      <div className="px-4 mt-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest">關卡</p>
          {isHost && (
            <button onClick={() => setShowStages(!showStages)}
                    className="text-xs text-medical-blue font-medium">
              {showStages ? '收起' : '更換'}
            </button>
          )}
        </div>

        {/* Selected stage card */}
        {!showStages && (
          <div className="bg-white rounded-2xl px-4 py-4 flex items-center gap-3 shadow-sm border border-gray-100">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl"
                 style={{ background: selectedStage.color + '20' }}>
              {selectedStage.icon}
            </div>
            <div className="flex-1">
              <p className="font-bold text-medical-dark">{selectedStage.name}</p>
              <p className="text-xs text-gray-400">{selectedStage.count} 題可用</p>
            </div>
            <div className="w-2 h-2 rounded-full" style={{ background: selectedStage.color }} />
          </div>
        )}

        {/* Stage grid */}
        {showStages && isHost && (
          <div className="grid grid-cols-2 gap-2">
            {STAGES.map(s => (
              <button key={s.id} onClick={() => handleStageChange(s.id)}
                      className={`flex items-center gap-2.5 px-3 py-3 rounded-xl text-sm font-medium transition-all active:scale-95
                        ${stage === s.id ? 'text-white shadow-md scale-105' : 'bg-white text-medical-dark border border-gray-100 shadow-sm'}`}
                      style={stage === s.id ? { background: s.color } : {}}>
                <span className="text-xl">{s.icon}</span>
                <div className="text-left">
                  <p className="font-semibold leading-tight text-xs">{s.name}</p>
                  <p className="opacity-60 text-xs">{s.count}題</p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Timer setting ───────────────────────────────────────── */}
      <div className="px-4 mt-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest">每題秒數</p>
          <p className="text-xs text-gray-400">{timerMode === 'auto' ? '依題目長度自動' : `固定 ${timerMode} 秒`}</p>
        </div>
        <div className="flex gap-2">
          {[['auto','自動'],['15','15秒'],['20','20秒'],['30','30秒'],['45','45秒']].map(([mode, label]) => (
            <button key={mode}
                    onClick={() => { if (!isHost) return; handleTimerMode(mode); setCustomSec('') }}
                    className={`flex-1 py-2.5 rounded-xl text-xs font-semibold transition-all active:scale-95
                      ${timerMode === mode && !customSec
                        ? 'text-white shadow grad-cta'
                        : 'bg-white text-gray-500 border border-gray-200'}`}>
              {label}
            </button>
          ))}
        </div>
        {isHost && (
          <div className="flex items-center gap-2 mt-2">
            <input
              type="number"
              min={5} max={120}
              className={`flex-1 border-2 rounded-xl px-3 py-2 text-center text-sm font-semibold outline-none transition-all
                ${customSec ? 'border-violet-500 bg-violet-50' : 'border-gray-200 bg-white text-gray-500'}`}
              placeholder="自訂秒數（5–120）"
              value={customSec}
              onChange={e => setCustomSec(e.target.value)}
            />
            <button
              onClick={() => {
                const v = parseInt(customSec)
                if (isNaN(v) || v < 5 || v > 120) return
                handleTimerMode(String(v))
              }}
              disabled={!customSec}
              className="px-4 py-2 rounded-xl text-white text-sm font-bold active:scale-95 transition-transform disabled:opacity-30"
              style={{ background: 'linear-gradient(135deg, #8B5CF6, #6366F1)' }}>
              套用
            </button>
          </div>
        )}
      </div>

      <div className="flex-1" />

      {/* ── Start button ────────────────────────────────────────── */}
      <div className="px-4 pb-10 mt-5">
        {isHost ? (
          <button
            onClick={handleStart}
            disabled={players.length < 2}
            className={`w-full py-5 rounded-2xl font-bold text-xl shadow-lg transition-all active:scale-95
              ${players.length >= 2
                ? 'text-white grad-cta-green'
                : 'bg-gray-200 text-gray-400'}`}
          >
            {players.length >= 2
              ? '🚀  開始遊戲'
              : <span className="flex items-center justify-center gap-2">等待玩家加入 <PulseDot /></span>}
          </button>
        ) : (
          <div className="bg-white rounded-2xl py-5 text-center text-gray-400 border border-gray-100 shadow-sm flex items-center justify-center gap-2 text-base">
            等待房主開始遊戲 <PulseDot />
          </div>
        )}
      </div>
    </div>
  )
}
