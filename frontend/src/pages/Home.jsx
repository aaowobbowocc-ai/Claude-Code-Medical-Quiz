import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore, getLevelTitle } from '../store/gameStore'
import { getSocket } from '../hooks/useSocket'
import { useDailyMessage } from '../hooks/useDailyMessage'
import { usePWA } from '../hooks/usePWA'
import { useBookmarks } from '../hooks/useBookmarks'

const AVATARS = ['👨‍⚕️','👩‍⚕️','🧑‍⚕️','👨‍🔬','👩‍🔬','🧬','🩺','💉']

// ── 外部連結（請依需求替換） ──────────────────────────────────────

const CONTACT_MAIL = 'aaowobbowocc@gmail.com'
// const ECPAY_URL = 'https://p.ecpay.com.tw/E11DBDD' // 審核通過後取消註解並恢復按鈕

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
  const { name, setName, coins, level, claimDailyBonus } = usePlayerStore()
  const [dailyClaimed, setDailyClaimed] = useState(false)

  useEffect(() => {
    const claimed = claimDailyBonus()
    if (claimed) setDailyClaimed(true)
  }, [])
  const { showBanner, isIOS, install, installPrompt, dismiss } = usePWA()
  const { getDueCount } = useBookmarks()
  const dueCount = getDueCount()
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
  const [createPublic, setCreatePublic] = useState(false)
  const [createPwd, setCreatePwd]       = useState('')
  const [joinPwd, setJoinPwd]           = useState('')
  const [needsPwd, setNeedsPwd]         = useState(false)
  const [publicRooms, setPublicRooms]   = useState([])
  const [roomsLoading, setRoomsLoading] = useState(false)

  // Quick-name: inline input shown only when no name
  const [quickName, setQuickName] = useState('')
  const quickRef = useRef(null)

  useEffect(() => {
    const s = socket
    const onErr = ({ message }) => {
      if (message === 'needs_password') {
        setNeedsPwd(true); setJoinError('此房間設有密碼，請輸入密碼')
      } else if (message === 'wrong_password') {
        setJoinError('密碼錯誤，請重試')
      } else {
        setJoinError(message)
      }
      setConnecting(false)
    }
    s.on('error', onErr)
    return () => s.off('error', onErr)
  }, [socket])

  // ── Actions ────────────────────────────────────────────────
  const doCreate = (nameToUse, { isPublic = false, password = null } = {}) => {
    setConnecting(true)
    socket.connect()
    socket.emit('create_room', { playerName: nameToUse, playerAvatar: av, isPublic, password })
  }

  const doJoin = (nameToUse) => {
    if (!joinCode.trim()) { setJoinError('請輸入邀請碼'); return }
    if (needsPwd && !joinPwd.trim()) { setJoinError('請輸入密碼'); return }
    setConnecting(true)
    setJoinError('')
    socket.connect()
    socket.emit('join_room', { code: joinCode.trim().toUpperCase(), playerName: nameToUse, playerAvatar: av, password: joinPwd || undefined })
  }

  const handleCreate = () => {
    if (name) { setCreatePublic(false); setCreatePwd(''); setSheet('create'); return }
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

  const fetchRooms = async () => {
    setRoomsLoading(true)
    try {
      const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
      const r = await fetch(`${BACKEND}/rooms`)
      setPublicRooms(await r.json())
    } catch { setPublicRooms([]) }
    setRoomsLoading(false)
  }

  const expPct = Math.min(((usePlayerStore.getState().exp || 0) / 300) * 100, 100)
  const { message: dailyMsg, loading: dailyLoading } = useDailyMessage(name, level)

  const sendContact = () => {
    if (!feedbackText.trim()) return
    const subj = encodeURIComponent('醫學知識王 意見／回報')
    const body = encodeURIComponent(feedbackText)
    window.open(`mailto:${CONTACT_MAIL}?subject=${subj}&body=${body}`)
    setFeedbackSent(true)
  }

  /* ── 底部支援列（主畫面共用） ──────────────────────────── */
  const darkMode = usePlayerStore(s => s.darkMode)
  const toggleDarkMode = usePlayerStore(s => s.toggleDarkMode)
  const heroGrad = darkMode
    ? 'linear-gradient(160deg, #1e1810 0%, #3e2c18 60%, #30220e 100%)'
    : 'linear-gradient(160deg, #0F2A3F 0%, #1A6B9A 60%, #0D9488 100%)'

  const SupportBar = () => (
    <div className="flex items-center justify-center gap-2 mt-3 pb-1">
      <button onClick={toggleDarkMode}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-gray-400 bg-white border border-gray-100 active:scale-95 transition-transform shadow-sm">
        {darkMode ? '☀️ 淺色' : '🌙 深色'}
      </button>
      <button onClick={() => setSheet('donate')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-amber-500 bg-amber-50 border border-amber-200 active:scale-95 transition-transform shadow-sm font-medium">
        ☕ 贊助開發者
      </button>
      <button onClick={() => setSheet('contact')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-gray-400 bg-white border border-gray-100 active:scale-95 transition-transform shadow-sm">
        💌 意見回饋
      </button>
    </div>
  )

  /* ── 聯絡 / 贊助 Sheets ─────────────────────────────────── */
  const SupportSheets = () => (
    <>
      {sheet === 'donate' && (
        <Sheet onClose={() => setSheet(null)}>
          <div className="text-center mb-5">
            <div className="text-5xl mb-3">☕</div>
            <h2 className="text-xl font-bold text-medical-dark">支持這個計畫</h2>
            <p className="text-gray-400 text-sm mt-2 leading-relaxed">
              「免費」是這裡的核心。<br />
              每位努力備考的醫學生，都值得一個好用的練習工具。
            </p>
          </div>

          <div className="bg-amber-50 rounded-2xl px-4 py-4 mb-5 text-sm text-amber-800 leading-relaxed space-y-1.5">
            <p>你的贊助會直接用於：</p>
            <p>🖥️ 伺服器費用，讓大家隨時連得到</p>
            <p>🤖 AI 解說功能，看懂每一道題</p>
            <p>📚 題庫持續更新，緊跟最新考試</p>
          </div>

          <div className="w-full py-4 rounded-2xl text-center mb-3 bg-gray-100 border-2 border-dashed border-gray-300">
            <p className="text-base font-bold text-gray-500">🔧 收款功能審核中</p>
            <p className="text-xs text-gray-400 mt-1">很快就好，感謝你的耐心等待 🙏</p>
          </div>

          <p className="text-center text-xs text-gray-300 leading-relaxed">
            不贊助也完全沒關係 🙏<br />這裡永遠為你開著。
          </p>
        </Sheet>
      )}

      {sheet === 'contact' && (
        <Sheet onClose={() => { setSheet(null); setFeedbackSent(false); setFeedbackText('') }}>
          {feedbackSent ? (
            <div className="text-center py-6">
              <div className="text-6xl mb-4">🙏</div>
              <h2 className="text-xl font-bold text-medical-dark mb-2">謝謝你！</h2>
              <p className="text-gray-400 text-sm leading-relaxed">
                每一條訊息我都會認真讀。<br />
                正是這樣的回饋讓這個專案繼續走下去。
              </p>
              <button onClick={() => { setSheet(null); setFeedbackSent(false); setFeedbackText('') }}
                      className="mt-6 px-8 py-3 rounded-2xl font-bold text-white active:scale-95 grad-cta">
                關閉
              </button>
            </div>
          ) : (
            <>
              <div className="text-center mb-5">
                <div className="text-5xl mb-3">💌</div>
                <h2 className="text-xl font-bold text-medical-dark">聯絡開發者</h2>
                <p className="text-gray-400 text-sm mt-1.5 leading-relaxed">
                  意見回饋、功能建議、題目有誤——<br />
                  什麼都可以說，我都想聽。
                </p>
              </div>
              <textarea
                autoFocus
                className="w-full border-2 border-gray-200 rounded-2xl px-4 py-3.5 text-sm text-gray-700 outline-none focus:border-medical-blue resize-none mb-4 leading-relaxed"
                rows={5}
                placeholder="例如：113年第一次第42題答案有疑義、希望新增某功能、或只是說聲謝謝……"
                value={feedbackText}
                onChange={e => setFeedbackText(e.target.value)}
              />
              <button
                onClick={sendContact}
                disabled={!feedbackText.trim()}
                className="w-full py-4 rounded-2xl font-bold text-lg text-white active:scale-95 transition-transform disabled:opacity-40 grad-cta"
              >
                以 Email 送出
              </button>
            </>
          )}
        </Sheet>
      )}
    </>
  )

  // ── No-name: inline quick-start ──────────────────────────
  if (!name) {
    return (
      <div className="flex flex-col min-h-dvh no-select bg-medical-ice">
        <div className="relative overflow-hidden px-5 pt-14 pb-10 flex flex-col items-center"
             style={{ background: heroGrad }}>
          {[...Array(6)].map((_, i) => (
            <div key={i} className="absolute text-white/5 font-bold text-7xl select-none"
                 style={{ top: `${10 + i * 28}%`, left: `${-5 + (i % 3) * 40}%` }}>✚</div>
          ))}
          <div className="relative text-6xl mb-3">⚕️</div>
          <h1 className="relative text-white font-bold text-3xl tracking-tight mb-1">醫學知識王</h1>
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
              className="w-full py-4 rounded-2xl font-bold text-lg text-white active:scale-95 transition-transform disabled:opacity-50 grad-cta"
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

          <div className="grid grid-cols-3 gap-2.5 w-full max-w-xs mt-1">
            {[['📝','模擬考','/mock-exam'],['🔥','魔王題','/boss'],['🎯','練習','/practice'],['📖','題庫','/browse'],['🏆','排行','/leaderboard'],['📊','紀錄','/history']].map(([icon,lbl,path]) => (
              <button key={path} onClick={() => navigate(path)}
                      className="bg-white rounded-2xl py-3 flex flex-col items-center gap-1 shadow-sm border border-gray-100 active:scale-95">
                <span className="text-xl">{icon}</span>
                <span className="text-xs text-gray-500 font-medium">{lbl}</span>
              </button>
            ))}
          </div>

          <SupportBar />
        </div>

        {/* Join sheet */}
        {sheet === 'join' && (
          <Sheet onClose={() => { setSheet(null); setJoinError(''); setJoinCode(''); setNeedsPwd(false); setJoinPwd('') }}>
            <h2 className="text-xl font-bold text-medical-dark text-center mb-2">加入房間</h2>
            <p className="text-center text-gray-400 text-sm mb-4">輸入好友的 6 碼邀請碼</p>
            <input
              autoFocus
              className="w-full border-2 border-medical-teal rounded-2xl px-4 py-4 text-3xl text-center font-mono tracking-[0.3em] outline-none focus:border-medical-accent mb-2 uppercase"
              placeholder="XXXXXX" value={joinCode}
              onChange={e => { setJoinCode(e.target.value.toUpperCase()); setJoinError(''); setNeedsPwd(false); setJoinPwd('') }}
              maxLength={6}
            />
            {needsPwd && (
              <input
                className="w-full border-2 border-amber-400 rounded-2xl px-4 py-3.5 text-base text-center outline-none focus:border-amber-500 mb-2"
                placeholder="🔒 請輸入房間密碼"
                type="password"
                value={joinPwd}
                onChange={e => { setJoinPwd(e.target.value); setJoinError('') }}
              />
            )}
            {joinError && <p className="text-medical-danger text-sm text-center mb-2 animate-shake">{joinError}</p>}
            <button onClick={handleJoin} disabled={connecting || joinCode.length < 6}
                    className="w-full py-4 rounded-2xl font-bold text-lg text-white mt-2 active:scale-95 transition-transform disabled:opacity-50 grad-cta-reverse">
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
    <div className="flex flex-col min-h-dvh no-select bg-medical-ice">

      {/* PWA Install Banner */}
      {showBanner && (
        <div className={`text-white px-4 py-3 flex items-center gap-3 ${darkMode ? 'bg-[#2d2d2d]' : 'bg-gradient-to-r from-medical-blue to-medical-teal'}`}>
          <span className="text-2xl shrink-0">📲</span>
          <div className="flex-1 min-w-0">
            {isIOS ? (
              <p className="text-xs leading-snug">
                點擊 Safari 底部 <span className="inline-block bg-white/20 rounded px-1 mx-0.5">⬆</span> 分享按鈕，再選「<strong>加入主畫面</strong>」即可安裝
              </p>
            ) : installPrompt ? (
              <p className="text-xs leading-snug">安裝到桌面，更快開啟、更好體驗</p>
            ) : (
              <p className="text-xs leading-snug">使用瀏覽器選單「加入主畫面」安裝 App</p>
            )}
          </div>
          {installPrompt && !isIOS && (
            <button onClick={install}
              className="shrink-0 bg-white text-medical-blue text-xs font-bold px-3 py-1.5 rounded-lg active:scale-95">
              安裝
            </button>
          )}
          <button onClick={dismiss} className="shrink-0 text-white/60 text-lg leading-none">&times;</button>
        </div>
      )}

      {/* Hero */}
      <div className="relative overflow-hidden px-5 pt-14 pb-6"
           style={{ background: heroGrad }}>
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
              <p className="text-white/40 text-xs">Lv.{level} {getLevelTitle(level).icon} {getLevelTitle(level).title}</p>
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

        {/* 每日獎勵 */}
        {dailyClaimed && (
          <div className="bg-amber-400/20 border border-amber-400/30 rounded-2xl px-4 py-3 mt-1 text-center animate-fadeIn">
            <p className="text-white font-bold text-sm">🎁 每日登入獎勵 +500 金幣！</p>
          </div>
        )}

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
                className="w-full rounded-2xl py-5 flex items-center px-5 gap-4 shadow-lg active:scale-[0.97] transition-transform disabled:opacity-60 grad-cta">
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

        <button onClick={() => { fetchRooms(); setSheet('browse') }}
                className="w-full rounded-2xl py-4 flex items-center px-5 gap-4 bg-white shadow-sm border border-gray-100 active:scale-[0.97] transition-transform">
          <div className="w-12 h-12 rounded-xl bg-emerald-50 flex items-center justify-center text-2xl shrink-0">🌐</div>
          <div className="text-left flex-1">
            <p className="text-medical-dark font-bold text-base leading-tight">公開房間</p>
            <p className="text-gray-400 text-xs mt-0.5">瀏覽並加入公開對戰</p>
          </div>
          <div className="text-gray-300 text-xl">›</div>
        </button>

        <button onClick={() => navigate('/history')}
                className="w-full rounded-2xl py-4 flex items-center px-5 gap-4 bg-white shadow-sm border border-gray-100 active:scale-[0.97] transition-transform">
          <div className="w-12 h-12 rounded-xl bg-amber-50 flex items-center justify-center text-2xl shrink-0">📊</div>
          <div className="text-left flex-1">
            <p className="text-medical-dark font-bold text-base leading-tight">對戰紀錄</p>
            <p className="text-gray-400 text-xs mt-0.5">查看歷史戰績與錯題檢討</p>
          </div>
          <div className="text-gray-300 text-xl">›</div>
        </button>

        <div className="flex items-center gap-3 my-0.5">
          <div className="flex-1 h-px bg-gray-200" />
          <span className="text-gray-400 text-xs">單人模式</span>
          <div className="flex-1 h-px bg-gray-200" />
        </div>

        <div className="grid grid-cols-3 gap-3">
          {[['📝','模擬考','100題/120分','/mock-exam'],
            ['🔥','魔王題','高答錯率挑戰','/boss'],
            ['🎯','自主練習','練習含AI對手','/practice'],
            ['📖','題庫瀏覽','依年份科目','/browse'],
            ['🏆','排行榜','每週排名','/leaderboard'],
            ['📊','歷史紀錄','對戰/練習/模考','/history']].map(([icon,title,sub,path]) => (
            <button key={path} onClick={() => navigate(path)}
                    className="rounded-2xl py-4 flex flex-col items-center gap-1.5 bg-white shadow-sm border border-gray-100 active:scale-[0.97] transition-transform">
              <div className="w-11 h-11 rounded-xl bg-medical-ice flex items-center justify-center text-2xl">{icon}</div>
              <p className="text-medical-dark font-bold text-xs">{title}</p>
              <p className="text-gray-400 text-xs">{sub}</p>
            </button>
          ))}
        </div>

        {dueCount > 0 && (
          <button onClick={() => navigate('/review', { state: { fromBookmarks: true } })}
                  className="w-full rounded-2xl py-3.5 px-4 flex items-center gap-3 bg-amber-50 border border-amber-200 active:scale-[0.97] transition-transform mt-1">
            <span className="text-2xl">🔔</span>
            <div className="flex-1 text-left">
              <p className="text-amber-800 font-bold text-sm">有 {dueCount} 題錯題該複習了</p>
              <p className="text-amber-600 text-xs">間隔複習，記得更牢</p>
            </div>
            <span className="text-amber-400">›</span>
          </button>
        )}

        <div className="flex gap-3 mt-1">
          {[{ icon:'📚', val:'2000', lbl:'題目' },{ icon:'📅', val:'110–115', lbl:'年份' },{ icon:'🔬', val:'9', lbl:'科目' }]
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
                  className="w-full py-4 rounded-2xl font-bold text-lg text-white active:scale-95 transition-transform grad-cta">
            儲存
          </button>
        </Sheet>
      )}

      {/* Sheet: join room */}
      {sheet === 'join' && (
        <Sheet onClose={() => { setSheet(null); setJoinError(''); setJoinCode(''); setNeedsPwd(false); setJoinPwd('') }}>
          <h2 className="text-xl font-bold text-medical-dark text-center mb-2">加入房間</h2>
          <p className="text-center text-gray-400 text-sm mb-4">輸入好友的 6 碼邀請碼</p>
          <input autoFocus
                 className="w-full border-2 border-medical-teal rounded-2xl px-4 py-4 text-3xl text-center font-mono tracking-[0.3em] outline-none focus:border-medical-accent mb-2 uppercase"
                 placeholder="XXXXXX" value={joinCode}
                 onChange={e => { setJoinCode(e.target.value.toUpperCase()); setJoinError(''); setNeedsPwd(false); setJoinPwd('') }}
                 maxLength={6} />
          {needsPwd && (
            <input
              className="w-full border-2 border-amber-400 rounded-2xl px-4 py-3.5 text-base text-center outline-none focus:border-amber-500 mb-2"
              placeholder="🔒 請輸入房間密碼"
              type="password"
              value={joinPwd}
              onChange={e => { setJoinPwd(e.target.value); setJoinError('') }}
            />
          )}
          {joinError && <p className="text-medical-danger text-sm text-center mb-2 animate-shake">{joinError}</p>}
          <button onClick={handleJoin} disabled={connecting || joinCode.length < 6}
                  className="w-full py-4 rounded-2xl font-bold text-lg text-white mt-2 active:scale-95 transition-transform disabled:opacity-50 grad-cta-reverse">
            {connecting ? '連線中...' : '加入'}
          </button>
        </Sheet>
      )}

      {/* Sheet: create room */}
      {sheet === 'create' && (
        <Sheet onClose={() => setSheet(null)}>
          <h2 className="text-xl font-bold text-medical-dark text-center mb-5">建立房間</h2>
          <div className="flex gap-3 mb-5">
            <button onClick={() => setCreatePublic(false)}
                    className={`flex-1 py-4 rounded-2xl text-sm font-bold border-2 transition-all
                      ${!createPublic ? 'border-medical-blue text-medical-blue bg-blue-50' : 'border-gray-200 text-gray-500 bg-white'}`}>
              🔒 私密房間<br/><span className="font-normal text-xs opacity-70">僅邀請碼可加入</span>
            </button>
            <button onClick={() => setCreatePublic(true)}
                    className={`flex-1 py-4 rounded-2xl text-sm font-bold border-2 transition-all
                      ${createPublic ? 'border-emerald-500 text-emerald-600 bg-emerald-50' : 'border-gray-200 text-gray-500 bg-white'}`}>
              🌐 公開房間<br/><span className="font-normal text-xs opacity-70">可被瀏覽及加入</span>
            </button>
          </div>
          {createPublic && (
            <div className="mb-5">
              <p className="text-xs text-gray-400 mb-2">設定密碼（選填，不填則開放加入）</p>
              <input
                className="w-full border-2 border-gray-200 rounded-2xl px-4 py-3.5 text-base text-center outline-none focus:border-medical-blue"
                placeholder="留空表示不需要密碼"
                value={createPwd}
                onChange={e => setCreatePwd(e.target.value)}
                maxLength={20}
              />
            </div>
          )}
          <button
            onClick={() => { setSheet(null); doCreate(name, { isPublic: createPublic, password: createPwd || null }) }}
            disabled={connecting}
            className="w-full py-4 rounded-2xl font-bold text-lg text-white active:scale-95 transition-transform disabled:opacity-50 grad-cta"
          >
            {connecting ? '連線中...' : '🏠 建立房間'}
          </button>
        </Sheet>
      )}

      {/* Sheet: browse public rooms */}
      {sheet === 'browse' && (
        <Sheet onClose={() => setSheet(null)}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-medical-dark">公開房間</h2>
            <button onClick={fetchRooms}
                    className="text-xs text-medical-blue font-medium px-3 py-1.5 bg-blue-50 rounded-xl active:scale-95">
              🔄 重新整理
            </button>
          </div>
          {roomsLoading ? (
            <div className="text-center text-gray-400 py-8">載入中...</div>
          ) : publicRooms.length === 0 ? (
            <div className="text-center text-gray-400 py-8">
              <p className="text-4xl mb-2">🏜️</p>
              <p className="text-sm">目前沒有公開房間</p>
              <p className="text-xs mt-1 opacity-60">建立一個公開房間，讓大家加入吧！</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5 max-h-80 overflow-y-auto">
              {publicRooms.map(room => (
                <button
                  key={room.code}
                  onClick={() => {
                    setJoinCode(room.code)
                    setNeedsPwd(room.hasPassword)
                    setJoinPwd('')
                    setJoinError(room.hasPassword ? '此房間設有密碼，請輸入密碼' : '')
                    setSheet('join')
                  }}
                  className="flex items-center gap-3 p-3.5 bg-white rounded-2xl border border-gray-100 shadow-sm text-left active:scale-[0.97] transition-transform"
                >
                  <div className="text-2xl">{room.stageIcon}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-medical-dark text-sm truncate">{room.hostName} 的房間</span>
                      {room.hasPassword && <span className="text-xs shrink-0">🔒</span>}
                    </div>
                    <p className="text-xs text-gray-400">{room.stageName} · {room.playerCount}/4 人</p>
                  </div>
                  <span className="font-mono text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded-lg shrink-0">{room.code}</span>
                </button>
              ))}
            </div>
          )}
        </Sheet>
      )}

      <SupportSheets />
    </div>
  )
}
