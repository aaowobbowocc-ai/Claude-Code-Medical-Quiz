import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/gameStore'
import { getSocket } from '../hooks/useSocket'
import { useDailyMessage } from '../hooks/useDailyMessage'

const AVATARS = ['👨‍⚕️','👩‍⚕️','🧑‍⚕️','👨‍🔬','👩‍🔬','🧬','🩺','💉']

// ── 外部連結（請依需求替換） ──────────────────────────────────────

const CONTACT_MAIL = 'aaowobbowocc@gmail.com'

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

  const [sheet, setSheet]         = useState(null)   // null | 'editname' | 'join' | 'bugreport' | 'feedback' | 'sponsor'
  const [inputName, setInputName] = useState('')
  const [joinCode, setJoinCode]   = useState('')
  const [joinError, setJoinError] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [feedbackText, setFeedbackText] = useState('')
  const [feedbackSent, setFeedbackSent] = useState(false)

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
  const { message: dailyMsg, loading: dailyLoading } = useDailyMessage(name, level)

  const sendFeedback = () => {
    if (!feedbackText.trim()) return
    window.open(`mailto:${CONTACT_MAIL}?subject=${encodeURIComponent('醫師知識王 意見回饋')}&body=${encodeURIComponent(feedbackText)}`)
    setFeedbackSent(true)
  }

  /* ── 底部支援列（主畫面共用） ──────────────────────────── */
  const SupportBar = () => (
    <div className="flex items-center justify-center gap-2 mt-3 pb-1">
      <button onClick={() => setSheet('bugreport')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-gray-400 bg-white border border-gray-100 active:scale-95 transition-transform shadow-sm">
        🐛 回報問題
      </button>
      <button onClick={() => setSheet('feedback')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-gray-400 bg-white border border-gray-100 active:scale-95 transition-transform shadow-sm">
        💌 意見回饋
      </button>
    </div>
  )

  /* ── 三個支援 Sheet ─────────────────────────────────────── */
  const SupportSheets = () => (
    <>
      {/* Bug Report */}
      {sheet === 'bugreport' && (
        <Sheet onClose={() => setSheet(null)}>
          <div className="text-center mb-5">
            <div className="text-5xl mb-3">🐛</div>
            <h2 className="text-xl font-bold text-medical-dark">發現問題了嗎？</h2>
            <p className="text-gray-400 text-sm mt-1.5 leading-relaxed">
              題目有誤、功能異常，或是任何讓你皺眉的地方——<br />
              你的每一條回報，都讓這個專案更完整。
            </p>
          </div>
          <div className="bg-amber-50 border border-amber-100 rounded-2xl p-4 mb-5 text-sm text-amber-800 leading-relaxed">
            <p className="font-semibold mb-1">常見問題請先確認：</p>
            <p>• 題目答案有疑義？可能來自原始考題，歡迎附上年份題號</p>
            <p>• 遊戲當掉或顯示異常？請描述操作步驟</p>
          </div>
          <button
            onClick={() => window.open(`mailto:${CONTACT_MAIL}?subject=${encodeURIComponent('醫師知識王 問題回報')}&body=${encodeURIComponent('【問題描述】\n\n【發生步驟】\n\n【題目年份/題號（若有）】\n')}`)}
            className="w-full py-4 rounded-2xl font-bold text-lg text-white active:scale-95 transition-transform"
            style={{ background: 'linear-gradient(135deg, #1A6B9A, #0D9488)' }}
          >
            以 Email 回報問題 →
          </button>
          <p className="text-center text-xs text-gray-300 mt-3">{CONTACT_MAIL}</p>
        </Sheet>
      )}

      {/* Feedback */}
      {sheet === 'feedback' && (
        <Sheet onClose={() => { setSheet(null); setFeedbackSent(false); setFeedbackText('') }}>
          {feedbackSent ? (
            <div className="text-center py-6">
              <div className="text-6xl mb-4">🙏</div>
              <h2 className="text-xl font-bold text-medical-dark mb-2">謝謝你！</h2>
              <p className="text-gray-400 text-sm leading-relaxed">
                你的意見我都會認真讀。<br />
                正是這樣的鼓勵讓開發者繼續走下去。
              </p>
              <button onClick={() => { setSheet(null); setFeedbackSent(false); setFeedbackText('') }}
                      className="mt-6 px-8 py-3 rounded-2xl font-bold text-white active:scale-95"
                      style={{ background: 'linear-gradient(135deg, #1A6B9A, #0D9488)' }}>
                關閉
              </button>
            </div>
          ) : (
            <>
              <div className="text-center mb-5">
                <div className="text-5xl mb-3">💌</div>
                <h2 className="text-xl font-bold text-medical-dark">告訴我你的想法</h2>
                <p className="text-gray-400 text-sm mt-1.5 leading-relaxed">
                  這個遊戲對你的備考有幫到忙嗎？<br />
                  還是有什麼你希望它能做到的？
                </p>
              </div>
              <textarea
                autoFocus
                className="w-full border-2 border-gray-200 rounded-2xl px-4 py-3.5 text-sm text-gray-700 outline-none focus:border-medical-blue resize-none mb-4 leading-relaxed"
                rows={5}
                placeholder="任何想說的都歡迎，沒有格式限制。哪個功能最有用、哪裡還可以改進、或只是說聲謝謝——都很棒。"
                value={feedbackText}
                onChange={e => setFeedbackText(e.target.value)}
              />
              <button
                onClick={sendFeedback}
                disabled={!feedbackText.trim()}
                className="w-full py-4 rounded-2xl font-bold text-lg text-white active:scale-95 transition-transform disabled:opacity-40"
                style={{ background: 'linear-gradient(135deg, #1A6B9A, #0D9488)' }}
              >
                送出意見
              </button>
              <p className="text-center text-xs text-gray-300 mt-3">將透過 Email 傳送</p>
            </>
          )}
        </Sheet>
      )}

    </>
  )

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

          <SupportBar />
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

        <SupportSheets />
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

        {/* 今日寄語 */}
        {(dailyMsg || dailyLoading) && (
          <div className="relative bg-white/8 border border-white/12 rounded-2xl px-4 py-3 mt-1">
            <p className="text-white/35 text-xs mb-1.5 tracking-wide">✨ 今日寄語</p>
            {dailyLoading && !dailyMsg ? (
              <div className="flex gap-1.5 py-1">
                {[0,1,2].map(i => (
                  <span key={i} className="w-1.5 h-1.5 rounded-full bg-white/30 animate-bounce"
                        style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
              </div>
            ) : (
              <p className="text-white/75 text-sm leading-relaxed">{dailyMsg}</p>
            )}
          </div>
        )}
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

        <SupportBar />
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

      <SupportSheets />
    </div>
  )
}
