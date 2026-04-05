import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore, getLevelTitle } from '../store/gameStore'
import { getSocket } from '../hooks/useSocket'
import { useDailyMessage } from '../hooks/useDailyMessage'
import { usePWA } from '../hooks/usePWA'
import { useBookmarks } from '../hooks/useBookmarks'
import Footer from '../components/Footer'
import Sheet from '../components/Sheet'
import SupportBar from '../components/SupportBar'
import SupportSheets from '../components/SupportSheets'

const AVATARS = ['👨‍⚕️','👩‍⚕️','🧑‍⚕️','👨‍🔬','👩‍🔬','🧬','🩺','💉']

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

  const darkMode = usePlayerStore(s => s.darkMode)
  const heroGrad = darkMode
    ? 'linear-gradient(160deg, #1e1810 0%, #3e2c18 60%, #30220e 100%)'
    : 'linear-gradient(160deg, #0F2A3F 0%, #1A6B9A 60%, #0D9488 100%)'

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

          <SupportBar setSheet={setSheet} />

          <Footer />
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

        <SupportSheets sheet={sheet} setSheet={setSheet} />
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
          {[{ icon:'📚', val:'2000', lbl:'題目' },{ icon:'📅', val:'110–115', lbl:'年份' },{ icon:'🔬', val:'10', lbl:'科目' }]
            .map(s => (
            <div key={s.lbl} className="flex-1 bg-white rounded-2xl py-3 flex flex-col items-center shadow-sm border border-gray-100">
              <span className="text-xl">{s.icon}</span>
              <span className="font-bold text-medical-dark text-sm">{s.val}</span>
              <span className="text-gray-400 text-xs">{s.lbl}</span>
            </div>
          ))}
        </div>

        {/* SEO 內容區塊 */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 text-sm text-gray-500 leading-relaxed space-y-3">
          <h2 className="font-bold text-base text-medical-dark">關於醫學知識王</h2>
          <p>
            醫學知識王是專為醫師國考第一階段設計的免費題庫練習平台，收錄 110 至 115 年度超過 2000 題考古題，
            涵蓋解剖學、生理學、生化學、藥理學、微生物與免疫學、寄生蟲學、病理學、組織學、胚胎學、公共衛生等 10 大基礎醫學科目。
            平台提供即時對戰、AI 題目解說、模擬考試（完整模擬醫學一＋醫學二，120/200 及格制）、
            錯題間隔複習等功能，讓醫學生在互動中高效備考。無需註冊，完全免費。
          </p>

          <h3 className="font-bold text-medical-dark">醫師國考一階制度簡介</h3>
          <p>
            醫師國考第一階段（一階）為考選部舉辦之專門職業及技術人員高等考試，每年舉行兩次（二月及七月），
            應考資格為完成基礎醫學課程之醫學系學生。考試分為「醫學（一）」與「醫學（二）」兩節，
            每節各 100 題選擇題，合計 200 題，採及格制（總分 120 分以上通過）。
            題目來源為考選部歷年公開試題，本平台忠實收錄並提供練習與解析。
          </p>

          <h3 className="font-bold text-medical-dark">考科範圍與準備方向</h3>
          <p>
            <strong>解剖學：</strong>人體各系統結構、神經走向、血管分布，著重臨床相關解剖（如手術入路、影像判讀）。
            <strong>生理學：</strong>各器官系統功能機制、恆定調控，心電圖判讀與腎臟生理為常考重點。
            <strong>生化學：</strong>代謝途徑、酵素動力學、分子生物學，維生素與營養代謝為基礎必考。
            <strong>藥理學：</strong>各類藥物作用機轉、副作用與交互作用，抗生素與心血管藥物佔比最高。
            <strong>微生物與免疫學：</strong>細菌、病毒、黴菌的致病機制與實驗室診斷，免疫反應的分類與調節。
            <strong>寄生蟲學：</strong>常見寄生蟲的生活史、感染途徑與治療藥物。
            <strong>病理學：</strong>疾病的形態變化與致病機轉，腫瘤分類與發炎反應為核心考點。
            <strong>組織學：</strong>各組織的顯微結構與功能特徵，光學與電子顯微鏡下的辨識。
            <strong>胚胎學：</strong>人體發育過程、先天異常的成因與機制。
            <strong>公共衛生：</strong>流行病學研究設計、生物統計基本概念、衛生政策與預防醫學。
          </p>

          <h3 className="font-bold text-medical-dark">平台功能特色</h3>
          <p>
            <strong>即時對戰：</strong>邀請同學組隊對戰，在競爭中提升答題速度與正確率，對戰結果即時顯示排行榜。
            <strong>模擬考試：</strong>完整模擬國考規格，200 題限時作答，自動計算成績並判定是否及格。
            <strong>AI 智慧解說：</strong>每道題目提供 AI 生成的詳細解析，包含答案說明、選項排除、記憶口訣與臨床應用。
            <strong>錯題複習：</strong>自動追蹤答錯題目，利用間隔重複原理安排複習時機，有效鞏固弱項。
            <strong>科目篩選：</strong>可依科目、年度自由篩選練習範圍，針對弱科重點加強。
            <strong>學習歷程：</strong>完整記錄每日練習量、答對率、各科表現趨勢，量化你的備考進度。
          </p>

          <h3 className="font-bold text-medical-dark">題目來源與免責聲明</h3>
          <p>
            本平台所有試題均來自考選部歷年公開之醫師國考試題與標準答案，版權歸考選部所有。
            AI 解說由人工智慧自動生成，僅供學習參考，不代表官方標準答案或解釋。
            使用者應以考選部公布之正式資料為準。本平台為非營利性質之免費教育工具，
            旨在協助醫學生高效備考，不收取任何費用。
          </p>
        </div>

        <SupportBar setSheet={setSheet} />

        <Footer />
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

      <SupportSheets sheet={sheet} setSheet={setSheet} />
    </div>
  )
}
