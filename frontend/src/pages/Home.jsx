import { useState, useEffect, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { usePlayerStore, getLevelTitle } from '../store/gameStore'
import { getExamTypes, getExamSeo, getExamConfig, getExamCategories, getExamsByCategory, getCategoryMeta, prefetchCategorySharedBanks } from '../config/examRegistry'
import { usePageMeta } from '../hooks/usePageMeta'
import { getSocket } from '../hooks/useSocket'
import { useDailyMessage } from '../hooks/useDailyMessage'
import { usePWA } from '../hooks/usePWA'
import { useBookmarks } from '../hooks/useBookmarks'
import Footer from '../components/Footer'
import Sheet from '../components/Sheet'
import SupportBar from '../components/SupportBar'
import SupportSheets from '../components/SupportSheets'
import RewardAdSheet from '../components/RewardAdSheet'
import { supabase, linkOrSignInGoogle, switchGoogleAccount, getLinkedIdentity } from '../lib/supabase'

const AVATARS = ['👨‍⚕️','👩‍⚕️','🧑‍⚕️','👨‍🔬','👩‍🔬','🧬','🩺','💉']

// EXAM_CONTENT is now loaded from exam-configs via getExamSeo(examId)

function ExamPickerContent({ exam, setExam, closeSheet }) {
  const currentCfg = getExamConfig(exam)
  // zustand's `exam` field defaults to 'doctor1' even for brand-new users, so we
  // can't use it alone to decide "has an exam been chosen yet". Gate on `name`:
  // no name = truly new user → force Stage 1 persona picker. Existing users
  // (with a name) jump straight to their current exam's Stage 2.
  const hasName = !!usePlayerStore.getState().name
  const initialCategory = hasName ? (currentCfg?.category || null) : null
  const [stage, setStage] = useState(initialCategory ? 'exam-list' : 'persona')
  const [activeCategory, setActiveCategory] = useState(initialCategory || null)

  const categories = getExamCategories()

  const goPersona = () => { setStage('persona'); setActiveCategory(null) }
  const pickCategory = (cat) => {
    const meta = getCategoryMeta(cat)
    if (!meta || meta.examCount === 0) {
      // Category is still 拓荒中 with zero exams — stay on persona and do nothing
      return
    }
    // Fire-and-forget: warm the Service Worker's shared-banks cache so the user
    // can practice offline the moment they open a reservoir-mode page.
    prefetchCategorySharedBanks(cat)
    setActiveCategory(cat)
    setStage('exam-list')
  }

  if (stage === 'persona') {
    return (
      <>
        <h2 className="text-xl font-bold text-medical-dark text-center mb-1">選擇身分領域</h2>
        <p className="text-center text-gray-400 text-sm mb-4">先選你的備考身分，再挑具體考試</p>

        <div className="grid grid-cols-2 gap-3">
          {categories.map(cat => {
            const meta = getCategoryMeta(cat.id) || cat
            const isEmpty = meta.examCount === 0
            const isPioneer = cat.pioneer
            return (
              <button
                key={cat.id}
                onClick={() => pickCategory(cat.id)}
                disabled={isEmpty}
                className={`relative rounded-2xl p-4 flex flex-col items-start gap-1.5 border-2 transition-all active:scale-95 text-left
                  ${isEmpty
                    ? 'border-gray-100 bg-gray-50 opacity-60 cursor-not-allowed'
                    : 'border-gray-100 bg-white hover:border-medical-blue hover:shadow'}`}
              >
                {isPioneer && (
                  <span className="absolute top-2 right-2 text-[9px] px-1.5 py-0.5 rounded-full font-bold text-amber-700 bg-amber-100">
                    拓荒中
                  </span>
                )}
                <span className="text-3xl">{cat.icon}</span>
                <span className="font-bold text-sm text-medical-dark">{cat.name}</span>
                <span className="text-[11px] text-gray-400 leading-snug">{cat.description}</span>
                <span className="text-[10px] text-medical-blue font-semibold mt-1">
                  {meta.examCount} 考試 · {meta.totalQ >= 1000 ? `${(meta.totalQ / 1000).toFixed(1)}k` : meta.totalQ} 題
                </span>
              </button>
            )
          })}
        </div>
      </>
    )
  }

  // Stage 2: exam list for the chosen category
  const catMeta = getCategoryMeta(activeCategory)
  const exams = getExamsByCategory(activeCategory)
  return (
    <>
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={goPersona}
          className="text-xs text-medical-blue font-semibold flex items-center gap-1 active:scale-95"
        >
          ← 返回分類
        </button>
        <h2 className="flex-1 text-center text-lg font-bold text-medical-dark">
          {catMeta?.icon} {catMeta?.name}
        </h2>
        <span className="w-10" />
      </div>
      <p className="text-center text-gray-400 text-xs mb-4">{catMeta?.description}</p>

      {exams.length === 0 ? (
        <div className="text-center py-8 text-sm text-gray-400">
          此分類題庫拓荒中，請稍候
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          {exams.map(e => (
            <button key={e.id}
              onClick={() => { setExam(e.id); closeSheet() }}
              className={`rounded-2xl p-4 flex flex-col items-center gap-1.5 border-2 transition-all active:scale-95
                ${exam === e.id ? 'border-medical-blue bg-medical-light shadow' : 'border-gray-100 bg-white'}`}>
              <span className="text-3xl">{e.icon}</span>
              <span className={`font-bold text-sm ${exam === e.id ? 'text-medical-blue' : 'text-medical-dark'}`}>
                {e.name}
              </span>
              {e.totalQ > 0 && (
                <span className="text-[10px] text-gray-400">{e.totalQ} 題</span>
              )}
              {e.totalQ === 0 && (
                <span className="text-[10px] text-amber-600 font-semibold">拓荒中</span>
              )}
            </button>
          ))}
        </div>
      )}
    </>
  )
}

function ExamArticle({ exam }) {
  const c = getExamSeo(exam.id) || getExamSeo('doctor1') || {}
  const isPioneer = !exam?.totalQ || exam.totalQ === 0 || !Array.isArray(c.subjectDetails) || c.subjectDetails.length === 0
  if (isPioneer) {
    return (
      <article className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 text-sm text-gray-500 leading-relaxed space-y-3">
        <h2 className="font-bold text-base text-medical-dark">關於{c.fullName || exam?.name}</h2>
        <p>
          <strong>{c.fullName || exam?.name}</strong> 題庫目前<span className="text-amber-600 font-semibold">拓荒中</span>，
          我們正在整理歷屆考古題與共享題庫（憲法、法學大意等），稍後會陸續上線。
        </p>
        {c.examDesc && <p>{c.examDesc}{c.paperDesc || ''}</p>}
        <p className="text-gray-400">
          想先試試其他考試？點畫面上方的考試名稱旁「▼」即可切換身分/領域。
        </p>
      </article>
    )
  }
  return (
    <article className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 text-sm text-gray-500 leading-relaxed space-y-3">
      <h2 className="font-bold text-base text-medical-dark">關於{c.title}</h2>
      <p>
        {c.title}是一個包含<strong>{c.fullName}</strong>在內的免費國考題庫練習平台，收錄 {c.years} 年度超過 {c.totalQ} 題考古題，
        涵蓋{c.subjects}。
        平台提供<Link to="/lobby" className="text-medical-blue underline">即時對戰</Link>、AI 題目解說、
        <Link to="/mock-exam" className="text-medical-blue underline">模擬考試</Link>（{c.mockDesc}）、
        錯題間隔複習等功能，讓{c.studentType}在互動中高效備考。無需註冊，完全免費。
      </p>

      <h3 className="font-bold text-medical-dark">{c.shortName}制度簡介</h3>
      <p>
        {c.examDesc}{c.paperDesc}題目來源為考選部歷年公開試題，本平台忠實收錄並提供練習與解析。
      </p>

      <h3 className="font-bold text-medical-dark">考科範圍與準備方向</h3>
      <p>
        {(c.subjectDetails || []).map(([name, desc]) => (
          <span key={name}><strong>{name}：</strong>{desc}</span>
        ))}
        所有科目皆可透過<Link to="/browse" className="text-medical-blue underline">題庫瀏覽</Link>依年度與科目篩選練習。
      </p>

      <h3 className="font-bold text-medical-dark">平台功能特色</h3>
      <ul className="list-disc pl-5 space-y-1">
        <li><strong><Link to="/lobby" className="text-medical-blue underline">即時對戰</Link>：</strong>邀請同學組隊對戰，在競爭中提升答題速度與正確率，對戰結果即時顯示排行榜。</li>
        <li><strong><Link to="/mock-exam" className="text-medical-blue underline">模擬考試</Link>：</strong>支援歷屆考題原卷作答與按比例隨機出題，完整模擬國考限時規格。</li>
        <li><strong>AI 智慧解說：</strong>每道題目提供 AI 生成的詳細解析，包含答案說明、選項排除、記憶口訣與臨床應用。</li>
        <li><strong>錯題複習：</strong>自動追蹤答錯題目，利用間隔重複原理安排複習時機，有效鞏固弱項。</li>
        <li><strong><Link to="/browse" className="text-medical-blue underline">題庫瀏覽</Link>：</strong>可依科目、年度自由篩選練習範圍，針對弱科重點加強。</li>
        <li><strong><Link to="/board" className="text-medical-blue underline">留言板</Link>：</strong>與其他{c.studentType}交流備考心得、分享讀書方法，互相鼓勵打氣。</li>
        <li><strong><Link to="/leaderboard" className="text-medical-blue underline">排行榜</Link>：</strong>查看全台{c.studentType}的答題表現排名，激勵持續進步。</li>
      </ul>

      <h3 className="font-bold text-medical-dark">題目來源與免責聲明</h3>
      <p>
        本平台所有試題均來自考選部歷年公開之{c.shortName}國考試題與標準答案，版權歸考選部所有。
        AI 解說由人工智慧自動生成，僅供學習參考，不代表官方標準答案或解釋。
        使用者應以考選部公布之正式資料為準。本平台為非營利性質之免費教育工具，
        旨在協助{c.studentType}高效備考，不收取任何費用。
        如有任何問題，歡迎透過<Link to="/contact" className="text-medical-blue underline">聯絡我們</Link>頁面反映。
        使用本平台即表示同意<Link to="/tos" className="text-medical-blue underline">服務條款</Link>與<Link to="/privacy" className="text-medical-blue underline">隱私政策</Link>。
      </p>
    </article>
  )
}

function getYearRange(examId) {
  const c = getExamSeo(examId)
  return c ? c.years.replace(/ /g, '') : '110至115'
}

function TutorialSection({ exam }) {
  const c = getExamSeo(exam.id) || getExamSeo('doctor1') || {}
  const timeLimit = exam.papers?.length >= 3 ? 180 : 120
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
      <h2 className="font-bold text-base text-medical-dark mb-3">📖 新手上路</h2>
      <div className="space-y-3">
        {[
          { step: '1', icon: '🎯', title: '自主練習', desc: '從科目選擇弱科，10 題快速練習，答完看 AI 詳解' },
          { step: '2', icon: '⚔️', title: '即時對戰', desc: '開房間邀朋友 PK，或加入公開房間，比速度也比正確率' },
          { step: '3', icon: '📝', title: '模擬考試', desc: `選歷屆原卷或隨機出題，${exam.totalQ} 題限時 ${timeLimit} 分鐘，模擬真實國考` },
          { step: '4', icon: '📋', title: '錯題複習', desc: '系統自動收集你的錯題，間隔複習時會提醒你，記得更牢' },
          { step: '5', icon: '💬', title: '留言板', desc: `和其他${c.studentType}交流心得、分享讀書方法，一起加油打氣` },
          { step: '6', icon: '🪙', title: '金幣系統', desc: '每日登入送金幣，連續登入加碼。用金幣解鎖 AI 解說、模擬考' },
        ].map(item => (
          <div key={item.step} className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-medical-blue text-white text-sm font-bold flex items-center justify-center shrink-0 mt-0.5">{item.step}</div>
            <div className="flex-1">
              <p className="font-bold text-sm text-medical-dark">{item.icon} {item.title}</p>
              <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{item.desc}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 bg-medical-ice rounded-xl p-3 text-center">
        <p className="text-xs text-gray-500">建議路線：<strong className="text-medical-dark">自主練習</strong> → <strong className="text-medical-dark">對戰</strong> → <strong className="text-medical-dark">模擬考</strong></p>
        <p className="text-xs text-gray-400 mt-1">先練熟基礎，再用對戰提速，最後模擬考驗收！</p>
      </div>
    </div>
  )
}

export default function Home() {
  const navigate = useNavigate()
  const { name, setName, coins, level, claimDailyBonus, loginStreak, bindRewardClaimed, claimBindReward } = usePlayerStore()
  const [bindRewardToast, setBindRewardToast] = useState(0)
  const [dailyClaimed, setDailyClaimed] = useState(false)
  const [dailyAmount, setDailyAmount] = useState(0)

  useEffect(() => {
    const amount = claimDailyBonus()
    if (amount) { setDailyClaimed(true); setDailyAmount(amount) }
    // Auto-open reward ad sheet if navigated with ?reward=1
    const params = new URLSearchParams(window.location.search)
    if (params.get('reward') === '1') {
      setSheet('reward-ad')
      window.history.replaceState({}, '', window.location.pathname)
      return
    }
    // Truly new user (no name) without a deep-link → force Stage 1 persona picker.
    // Zustand defaults exam='doctor1' so we can't trust the exam field to detect
    // "has chosen". We check URL ?exam= directly instead of sessionStorage because
    // React fires child effects before parent effects — App.jsx's deep-link handler
    // hasn't run yet when this Home effect fires on first mount.
    const deepLinkExam = params.get('exam')
    const deepLinkValid = deepLinkExam && getExamConfig(deepLinkExam)
    if (!name && !deepLinkValid) {
      setSheet('exam')
    }
  }, [])
  const { showBanner, isIOS, install, installPrompt, dismiss } = usePWA()
  const { getDueCount } = useBookmarks()
  const dueCount = getDueCount()
  const [devTaps, setDevTaps] = useState(0)
  const devTimer = useRef(null)
  const [devCoinsInput, setDevCoinsInput] = useState('')
  const [devAuthed, setDevAuthed] = useState(false)
  const [devPwdInput, setDevPwdInput] = useState('')
  const [devPwdError, setDevPwdError] = useState(false)
  const DEV_PWD = 'haha9527'
  const handleDevTap = () => {
    setDevTaps(t => {
      const next = t + 1
      clearTimeout(devTimer.current)
      if (next >= 5) { setSheet('devpwd'); setDevPwdInput(''); setDevPwdError(false); return 0 }
      devTimer.current = setTimeout(() => setDevTaps(0), 1500)
      return next
    })
  }
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

  const exam = usePlayerStore(s => s.exam) || 'doctor1'
  const setExam = usePlayerStore(s => s.setExam)
  // Hard fallback so that even if registry fetch fails (offline/backend down) the page
  // still renders instead of crashing on currentExam.icon — App.jsx gates first paint
  // on registry readiness, this is just belt-and-braces.
  const currentExam = getExamTypes().find(e => e.id === exam) || getExamTypes()[0] || {
    id: 'doctor1', name: '醫師一階', short: '醫一', icon: '🩺', papers: [],
  }

  // Dynamic SEO title / canonical / og per exam — powers Threads/FB/Google previews
  // when someone shares examking.tw/?exam=<id>
  usePageMeta(
    currentExam ? `國考知識王｜${currentExam.name}` : null,
    currentExam ? `${currentExam.name}國考題庫練習，涵蓋歷屆考古題、即時對戰、AI 解說、模擬考、弱點分析，免費使用！` : null,
    { canonical: currentExam ? `https://examking.tw/?exam=${currentExam.id}` : 'https://examking.tw/' }
  )

  // Quick-name: inline input shown only when no name
  const [quickName, setQuickName] = useState('')
  const quickRef = useRef(null)

  // ── Supabase auth state (for Google bind UI) ─────────────────
  const [authUser, setAuthUser] = useState(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [authMsg, setAuthMsg] = useState('')
  useEffect(() => {
    if (!supabase) return
    supabase.auth.getUser().then(({ data }) => setAuthUser(data.user))
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      setAuthUser(session?.user || null)
    })
    return () => sub.subscription.unsubscribe()
  }, [])
  const linkedIdentity = getLinkedIdentity(authUser)
  const isAnon = authUser?.is_anonymous === true

  const handleLinkGoogle = async () => {
    setAuthBusy(true); setAuthMsg('')
    const r = await linkOrSignInGoogle()
    if (r.error) { setAuthMsg('連線失敗：' + r.error); setAuthBusy(false) }
    // On linking/signingIn, browser redirects — no UI to update
  }
  const handleSwitchGoogle = async () => {
    setAuthBusy(true); setAuthMsg('')
    const r = await switchGoogleAccount()
    if (r.error) { setAuthMsg('連線失敗：' + r.error); setAuthBusy(false) }
    // On switching, browser redirects — no UI to update
  }

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
    socket.emit('create_room', { playerName: nameToUse, playerAvatar: av, isPublic, password, exam })
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

  // Friend tapped an invite link? Tell the new user what's waiting for them so the
  // "enter your name" step doesn't feel like a cold gate.
  let pendingJoinCode = null
  try { pendingJoinCode = sessionStorage.getItem('pending-join-room') } catch {}

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
          {pendingJoinCode && (
            <div className="relative w-full mb-3 bg-white/15 border border-white/25 rounded-2xl px-4 py-3 backdrop-blur text-center">
              <p className="text-white text-sm font-semibold">🎯 你的朋友正在房間等你</p>
              <p className="text-white/60 text-xs mt-0.5">邀請碼 <span className="font-mono tracking-widest">{pendingJoinCode}</span> · 填完名字就會自動加入</p>
            </div>
          )}
          <div className="relative text-5xl mb-2">{currentExam.icon}</div>
          <h1 className="relative text-white font-bold text-3xl tracking-tight mb-1">國考知識王</h1>
          <button onClick={() => setSheet('exam')}
                  className="relative text-white/50 text-sm flex items-center gap-1 active:scale-95 transition-transform">
            {currentExam.name} · 即時對戰 <span className="text-white/30 text-xs">▼</span>
          </button>
          <div className="relative flex gap-3 mt-3 text-2xl opacity-80">
            <span>🩺</span>
            <span>🦷</span>
            <span>💊</span>
            <span>⚖️</span>
            <span>📜</span>
          </div>
          <p className="relative text-white/40 text-[10px] mt-1">涵蓋 20 類國考 · 50,000+ 題</p>
        </div>

        <div className="flex-1 px-4 pt-4 pb-8 flex flex-col gap-3 -mt-4">
          {/* Avatar row */}
          <div className="flex gap-2 justify-center mb-0">
            {AVATARS.map(a => (
              <button key={a} onClick={() => setAvatar?.(a)}
                      className={`w-11 h-11 rounded-xl text-2xl flex items-center justify-center transition-all active:scale-90
                        ${av === a ? 'bg-medical-blue scale-105 shadow' : 'bg-white shadow-sm'}`}>
                {a}
              </button>
            ))}
          </div>

          {/* Name input — inline, no modal */}
          <div className="relative">
            <input
              ref={quickRef}
              autoFocus
              className="w-full border-2 border-medical-blue rounded-2xl pl-4 pr-16 py-4 text-xl text-center outline-none focus:border-medical-accent font-medium bg-white shadow-sm"
              placeholder="輸入你的名字"
              value={quickName}
              onChange={e => setQuickName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && quickName.trim() && (setName(quickName.trim()))}
              maxLength={12}
            />
            <button
              onClick={() => quickName.trim() && setName(quickName.trim())}
              disabled={!quickName.trim()}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-12 h-12 rounded-xl bg-medical-blue text-white text-2xl font-bold flex items-center justify-center active:scale-90 transition-transform disabled:opacity-30 disabled:cursor-not-allowed shadow"
              aria-label="確認名字">
              ✓
            </button>
          </div>

          {/* Google sign-in shortcut — recovers cross-device data */}
          {supabase && (
            <button onClick={handleLinkGoogle} disabled={authBusy}
              className="w-full py-3 rounded-2xl text-sm font-bold bg-white border-2 border-amber-300 text-amber-700 flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50 -mt-1">
              <span className="text-lg">🎁</span>
              {authBusy ? '連線中…' : '用 Google 登入立即送 3000 🪙'}
            </button>
          )}
          {authMsg && <p className="text-xs text-red-500 text-center -mt-1">{authMsg}</p>}

          {/* Action buttons — card style matching logged-in view */}
          <button
            onClick={handleCreate}
            disabled={connecting}
            className="w-full rounded-2xl py-5 flex items-center px-5 gap-4 shadow-lg active:scale-[0.97] transition-transform disabled:opacity-60 grad-cta"
          >
            <div className="w-12 h-12 rounded-xl bg-white/20 flex items-center justify-center text-2xl shrink-0">🏠</div>
            <div className="text-left flex-1">
              <p className="text-white font-bold text-xl leading-tight">建立房間</p>
              <p className="text-white/60 text-xs mt-0.5">邀請好友一起對戰</p>
            </div>
            <div className="text-white/50 text-xl">›</div>
          </button>

          <button
            onClick={() => setSheet('join')}
            className="w-full rounded-2xl py-5 flex items-center px-5 gap-4 bg-white shadow-sm border border-gray-100 active:scale-[0.97] transition-transform"
          >
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

          <div className="grid grid-cols-3 gap-3">
            {[['📝','模擬考','歷屆/隨機模擬','/mock-exam'],
              ['📒','精華筆記',`${currentExam.papers?.length || 2}卷高頻考點`,'/notes'],
              ['🎯','自主練習','練習含AI對手','/practice'],
              ['📖','題庫瀏覽',`${getYearRange(exam)}年題庫`,'/browse'],
              ['📊','弱點分析','各科正確率','/weakness'],
              ['⭐','收藏題目','分類收藏複習','/favorites'],
              ['🏆','排行榜','每週排名','/leaderboard'],
              ['💬','留言板','交流備考心得','/board']].map(([icon,title,sub,path]) => (
              <button key={path} onClick={() => navigate(path)}
                      className="rounded-2xl py-4 flex flex-col items-center gap-1.5 bg-white shadow-sm border border-gray-100 active:scale-[0.97] transition-transform">
                <div className="w-11 h-11 rounded-xl bg-medical-ice flex items-center justify-center text-2xl">{icon}</div>
                <p className="text-medical-dark font-bold text-xs">{title}</p>
                <p className="text-gray-400 text-xs">{sub}</p>
              </button>
            ))}
          </div>

          <TutorialSection exam={currentExam} />
          <ExamArticle exam={currentExam} />

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

        {/* Exam picker */}
        {sheet === 'exam' && (
          <Sheet onClose={() => setSheet(null)}>
            <ExamPickerContent exam={exam} setExam={setExam} closeSheet={() => setSheet(null)} />
          </Sheet>
        )}

        <SupportSheets sheet={sheet} setSheet={setSheet} />
        {sheet === 'reward-ad' && <RewardAdSheet onClose={() => setSheet(null)} />}
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

      {/* Bind reward banner — visible only when Google linked & not yet claimed */}
      {linkedIdentity && !bindRewardClaimed && (
        <button
          onClick={() => {
            const got = claimBindReward()
            if (got) { setBindRewardToast(got); setTimeout(() => setBindRewardToast(0), 2500) }
          }}
          className="w-full px-4 py-3 flex items-center gap-3 active:scale-[0.98] transition-transform"
          style={{ background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)' }}>
          <span className="text-2xl shrink-0">🎁</span>
          <div className="flex-1 text-left min-w-0">
            <p className="text-white font-bold text-sm leading-tight">綁定 Google 獎勵已準備好！</p>
            <p className="text-white/80 text-[11px] mt-0.5">點擊領取 +3000 🪙 感謝您的支持</p>
          </div>
          <span className="shrink-0 bg-white text-amber-700 text-xs font-bold px-3 py-1.5 rounded-lg">領取</span>
        </button>
      )}

      {/* Bind invitation banner — visible to anonymous (unlinked) users */}
      {supabase && !linkedIdentity && !bindRewardClaimed && authUser && (
        <button
          onClick={handleLinkGoogle}
          disabled={authBusy}
          className="w-full px-4 py-3 flex items-center gap-3 active:scale-[0.98] transition-transform disabled:opacity-60"
          style={{ background: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)' }}>
          <span className="text-2xl shrink-0">🎁</span>
          <div className="flex-1 text-left min-w-0">
            <p className="text-white font-bold text-sm leading-tight">綁定 Google 立即送 3000 🪙</p>
            <p className="text-white/85 text-[11px] mt-0.5">同步跨裝置進度，換手機也不怕資料消失</p>
          </div>
          <span className="shrink-0 bg-white text-amber-700 text-xs font-bold px-3 py-1.5 rounded-lg">
            {authBusy ? '連線中…' : '立即綁定'}
          </span>
        </button>
      )}

      {/* Bind reward toast */}
      {bindRewardToast > 0 && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-white border-2 border-amber-400 rounded-2xl px-5 py-3 shadow-2xl flex items-center gap-3 animate-bounce">
          <span className="text-3xl">🎉</span>
          <div>
            <p className="font-bold text-amber-700 text-sm">+{bindRewardToast} 金幣</p>
            <p className="text-xs text-gray-500">綁定獎勵已入帳</p>
          </div>
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
          <button onClick={() => setSheet('exam')} className="text-left active:scale-95 transition-transform">
            <p className="text-white/50 text-xs font-medium tracking-widest mb-0.5 flex items-center gap-1">
              {currentExam.icon} {currentExam.name} <span className="text-white/30">▼</span>
            </p>
            <h1 className="text-white font-bold text-2xl tracking-tight leading-none" onClick={(e) => { e.stopPropagation(); handleDevTap() }}>國考知識王</h1>
            <div className="flex gap-2 mt-1.5 text-base opacity-80">
              <span>🩺</span><span>🦷</span><span>💊</span><span>⚖️</span><span>📜</span>
            </div>
            <p className="text-white/50 text-[10px] mt-0.5">涵蓋 20 類國考 · 50,000+ 題</p>
          </button>
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
              <div className="flex items-center gap-1.5">
                <p className="text-white font-bold text-lg">🪙 {coins}</p>
                <button onClick={() => setSheet('reward-ad')}
                  className="text-xs bg-amber-400/30 text-amber-200 px-1.5 py-0.5 rounded-lg font-bold active:scale-90 transition-transform">
                  ➕
                </button>
              </div>
            </div>
          </div>
          <div className="w-full h-1.5 bg-white/20 rounded-full">
            <div className="h-full bg-white/70 rounded-full transition-all duration-500" style={{ width: `${expPct}%` }} />
          </div>
        </div>

        {/* 每日獎勵 */}
        {dailyClaimed && (
          <div className="bg-amber-400/20 border border-amber-400/30 rounded-2xl px-4 py-3 mt-1 text-center animate-fadeIn">
            <p className="text-white font-bold text-sm">🎁 每日登入獎勵 +{dailyAmount} 金幣！</p>
            {loginStreak >= 2 && (
              <p className="text-amber-300/80 text-xs mt-1">🔥 連續登入 {loginStreak} 天{loginStreak >= 7 ? ' · 最高加成！' : loginStreak >= 5 ? ' · +150 加成' : loginStreak >= 3 ? ' · +100 加成' : ' · +50 加成'}</p>
            )}
          </div>
        )}

        {/* 看廣告賺金幣 */}
        <button onClick={() => setSheet('reward-ad')}
          className="w-full bg-white/10 border border-amber-400/30 rounded-2xl px-4 py-3 mt-1 text-center active:scale-[0.97] transition-transform">
          <p className="text-white font-bold text-sm">🎬 看廣告免費領金幣</p>
          <p className="text-white/40 text-xs mt-0.5">功能準備中，即將開放</p>
        </button>

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
          {[['📝','模擬考','歷屆/隨機模擬','/mock-exam'],
            ['📒','精華筆記',`${currentExam.papers?.length || 2}卷高頻考點`,'/notes'],
            ['🎯','自主練習','練習含AI對手','/practice'],
            ['📖','題庫瀏覽',`${getYearRange(exam)}年題庫`,'/browse'],
            ['📊','弱點分析','各科正確率','/weakness'],
            ['⭐','收藏題目','分類收藏複習','/favorites'],
            ['🏆','排行榜','每週排名','/leaderboard'],
            ['💬','留言板','交流備考心得','/board']].map(([icon,title,sub,path]) => (
            <button key={path} onClick={() => navigate(path)}
                    className="rounded-2xl py-4 flex flex-col items-center gap-1.5 bg-white shadow-sm border border-gray-100 active:scale-[0.97] transition-transform">
              <div className="w-11 h-11 rounded-xl bg-medical-ice flex items-center justify-center text-2xl">{icon}</div>
              <p className="text-medical-dark font-bold text-xs">{title}</p>
              <p className="text-gray-400 text-xs">{sub}</p>
            </button>
          ))}
        </div>

        {dueCount > 0 && (
          <button onClick={() => navigate('/favorites')}
                  className="w-full rounded-2xl py-3.5 px-4 flex items-center gap-3 bg-amber-50 border border-amber-200 active:scale-[0.97] transition-transform mt-1">
            <span className="text-2xl">🔔</span>
            <div className="flex-1 text-left">
              <p className="text-amber-800 font-bold text-sm">有 {dueCount} 題收藏該複習了</p>
              <p className="text-amber-600 text-xs">間隔複習，記得更牢</p>
            </div>
            <span className="text-amber-400">›</span>
          </button>
        )}

        <TutorialSection exam={currentExam} />

        {/* SEO 內容區塊 */}
        <ExamArticle exam={currentExam} />

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

          {/* ── Account binding ─────────────────────── */}
          {supabase && (
            <div className="mt-5 pt-5 border-t border-gray-100">
              <p className="text-xs text-gray-400 mb-2 text-center">帳號綁定</p>
              {linkedIdentity ? (
                <>
                  <div className="bg-emerald-50 border border-emerald-200 rounded-2xl px-4 py-3 flex items-center gap-3">
                    <span className="text-2xl">✅</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-emerald-700">已綁定 Google</p>
                      <p className="text-xs text-emerald-600 truncate">{linkedIdentity.email || '已連結'}</p>
                    </div>
                    <button onClick={handleSwitchGoogle} disabled={authBusy}
                            className="text-xs text-medical-blue px-3 py-1.5 bg-white border border-medical-blue/30 rounded-lg active:scale-95 disabled:opacity-50 whitespace-nowrap">
                      換綁
                    </button>
                  </div>
                  {!bindRewardClaimed && (
                    <button
                      onClick={() => {
                        const got = claimBindReward()
                        if (got) { setBindRewardToast(got); setTimeout(() => setBindRewardToast(0), 2500) }
                      }}
                      className="mt-3 w-full py-3 rounded-2xl font-bold text-sm text-white flex items-center justify-center gap-2 active:scale-95 shadow-md"
                      style={{ background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)' }}>
                      <span className="text-lg">🎁</span> 領取綁定獎勵 +3000 🪙
                    </button>
                  )}
                </>
              ) : (
                <>
                  {!bindRewardClaimed && (
                    <div className="mb-2 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 flex items-center gap-2">
                      <span className="text-lg">🎁</span>
                      <p className="text-xs text-amber-700 font-bold flex-1">綁定即送 3000 金幣</p>
                    </div>
                  )}
                  <button onClick={handleLinkGoogle} disabled={authBusy}
                          className="w-full py-3 rounded-2xl font-bold text-sm bg-white border-2 border-amber-300 text-amber-700 flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50">
                    <span className="text-xl">🔗</span>
                    {authBusy ? '連線中…' : isAnon ? '綁定 Google 帳號' : '使用 Google 登入'}
                  </button>
                  <p className="text-[10px] text-gray-400 text-center mt-2 leading-relaxed">
                    {isAnon
                      ? '綁定後可在不同裝置同步金幣與進度，現有資料會保留'
                      : '使用 Google 登入以同步跨裝置的進度'}
                  </p>
                </>
              )}
              {authMsg && <p className="text-xs text-red-500 text-center mt-2">{authMsg}</p>}
            </div>
          )}
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

      {/* Exam picker */}
      {sheet === 'exam' && (
        <Sheet onClose={() => setSheet(null)}>
          <ExamPickerContent exam={exam} setExam={setExam} closeSheet={() => setSheet(null)} />
        </Sheet>
      )}

      <SupportSheets sheet={sheet} setSheet={setSheet} />

      {/* Reward ad sheet */}
      {sheet === 'reward-ad' && <RewardAdSheet onClose={() => setSheet(null)} />}

      {/* Dev password gate */}
      {sheet === 'devpwd' && (
        <Sheet onClose={() => setSheet(null)}>
          <h2 className="text-xl font-bold text-medical-dark text-center mb-1">開發者驗證</h2>
          <p className="text-center text-gray-400 text-xs mb-4">請輸入開發者密碼</p>
          <div className="space-y-3">
            <input type="password" value={devPwdInput} onChange={e => { setDevPwdInput(e.target.value); setDevPwdError(false) }}
              placeholder="密碼" className="w-full border rounded-xl px-3 py-2 text-sm text-center" autoFocus />
            {devPwdError && <p className="text-red-500 text-xs text-center">密碼錯誤</p>}
            <button onClick={() => {
              if (devPwdInput === DEV_PWD) { setDevAuthed(true); setSheet('dev') }
              else { setDevPwdError(true) }
            }} className="w-full bg-medical-blue text-white py-2.5 rounded-xl text-sm font-bold active:scale-95">確認</button>
          </div>
        </Sheet>
      )}

      {/* Dev panel — only after password */}
      {sheet === 'dev' && devAuthed && (
        <Sheet onClose={() => { setSheet(null); setDevAuthed(false) }}>
          <h2 className="text-xl font-bold text-medical-dark text-center mb-1">開發者工具</h2>
          <p className="text-center text-gray-400 text-xs mb-4">測試用，不影響其他玩家</p>
          <div className="space-y-3">
            <div className="flex gap-2">
              <input type="number" value={devCoinsInput} onChange={e => setDevCoinsInput(e.target.value)}
                placeholder="輸入金幣數量" className="flex-1 border rounded-xl px-3 py-2 text-sm" />
              <button onClick={() => { const n = parseInt(devCoinsInput); if (n) { usePlayerStore.getState().addCoins(n); setDevCoinsInput('') } }}
                className="bg-amber-500 text-white px-4 py-2 rounded-xl text-sm font-bold active:scale-95">加金幣</button>
            </div>
            <div className="flex gap-2">
              <button onClick={() => { usePlayerStore.getState().addCoins(1000) }}
                className="flex-1 bg-amber-100 text-amber-700 py-2 rounded-xl text-sm font-bold active:scale-95">+1,000</button>
              <button onClick={() => { usePlayerStore.getState().addCoins(5000) }}
                className="flex-1 bg-amber-100 text-amber-700 py-2 rounded-xl text-sm font-bold active:scale-95">+5,000</button>
              <button onClick={() => { usePlayerStore.getState().addCoins(10000) }}
                className="flex-1 bg-amber-100 text-amber-700 py-2 rounded-xl text-sm font-bold active:scale-95">+10,000</button>
            </div>
            <div className="flex gap-2">
              <button onClick={() => { usePlayerStore.setState({ coins: 0 }) }}
                className="flex-1 bg-red-100 text-red-600 py-2 rounded-xl text-sm font-bold active:scale-95">歸零</button>
              <button onClick={() => { usePlayerStore.setState({ coins: 500 }) }}
                className="flex-1 bg-gray-100 text-gray-600 py-2 rounded-xl text-sm font-bold active:scale-95">重設 500</button>
            </div>
            <p className="text-center text-gray-400 text-xs">目前金幣：🪙 {coins}</p>
          </div>
        </Sheet>
      )}
    </div>
  )
}
