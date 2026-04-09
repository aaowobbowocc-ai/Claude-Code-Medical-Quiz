import { useState, useEffect, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { usePlayerStore, getLevelTitle, EXAM_TYPES } from '../store/gameStore'
import { getSocket } from '../hooks/useSocket'
import { useDailyMessage } from '../hooks/useDailyMessage'
import { usePWA } from '../hooks/usePWA'
import { useBookmarks } from '../hooks/useBookmarks'
import Footer from '../components/Footer'
import Sheet from '../components/Sheet'
import SupportBar from '../components/SupportBar'
import SupportSheets from '../components/SupportSheets'

const AVATARS = ['👨‍⚕️','👩‍⚕️','🧑‍⚕️','👨‍🔬','👩‍🔬','🧬','🩺','💉']

// Exam-specific content for SEO article
const EXAM_CONTENT = {
  doctor1: {
    title: '醫學知識王',
    fullName: '醫師國考第一階段',
    shortName: '醫師一階',
    studentType: '醫學生',
    years: '110 至 115',
    totalQ: 2000,
    examDesc: '醫師國考第一階段（一階）為考選部舉辦之專門職業及技術人員高等考試，每年舉行兩次（二月及七月），應考資格為完成基礎醫學課程之醫學系學生。',
    paperDesc: '考試分為「醫學（一）」與「醫學（二）」兩節，每節各 100 題選擇題，合計 200 題，採及格制（總分 120 分以上通過）。',
    subjects: '解剖學、生理學、生化學、藥理學、微生物與免疫學、寄生蟲學、病理學、組織學、胚胎學、公共衛生等 10 大基礎醫學科目',
    mockDesc: '完整模擬醫學(一)＋醫學(二)，120/200 及格制',
    subjectDetails: [
      ['解剖學', '人體各系統結構、神經走向、血管分布，著重臨床相關解剖（如手術入路、影像判讀）。'],
      ['生理學', '各器官系統功能機制、恆定調控，心電圖判讀與腎臟生理為常考重點。'],
      ['生化學', '代謝途徑、酵素動力學、分子生物學，維生素與營養代謝為基礎必考。'],
      ['藥理學', '各類藥物作用機轉、副作用與交互作用，抗生素與心血管藥物佔比最高。'],
      ['微生物與免疫學', '細菌、病毒、黴菌的致病機制與實驗室診斷，免疫反應的分類與調節。'],
      ['寄生蟲學', '常見寄生蟲的生活史、感染途徑與治療藥物。'],
      ['病理學', '疾病的形態變化與致病機轉，腫瘤分類與發炎反應為核心考點。'],
      ['組織學', '各組織的顯微結構與功能特徵，光學與電子顯微鏡下的辨識。'],
      ['胚胎學', '人體發育過程、先天異常的成因與機制。'],
      ['公共衛生', '流行病學研究設計、生物統計基本概念、衛生政策與預防醫學。'],
    ],
  },
  doctor2: {
    title: '醫學知識王',
    fullName: '醫師國考第二階段',
    shortName: '醫師二階',
    studentType: '醫學生',
    years: '110 至 115',
    totalQ: 1920,
    examDesc: '醫師國考第二階段（二階）為考選部舉辦之專門職業及技術人員高等考試，每年舉行一至兩次，應考資格為通過一階並完成臨床實習之醫學系學生。',
    paperDesc: '考試分為「醫學(三)」至「醫學(六)」共四節，每節各 80 題選擇題，合計 320 題。每題 1.25 分、每卷滿分 100 分，總分 400 分，及格標準為 192 分（60%）。',
    subjects: '內科、外科、小兒科、婦產科、精神科、神經科、皮膚科、骨科、泌尿科、眼科、耳鼻喉科、復健科、急診醫學、醫療法規等臨床醫學科目',
    mockDesc: '完整模擬醫學(三)～(六)四卷，每題 1.25 分，192/400 及格',
    subjectDetails: [
      ['內科', '各系統內科疾病的診斷、治療與處置，心臟、胸腔、腸胃、腎臟、內分泌為重點。'],
      ['外科', '一般外科、消化外科、心臟外科的手術適應症與術後照護。'],
      ['小兒科', '兒童常見疾病、生長發育、新生兒照護與兒童預防接種。'],
      ['婦產科', '產科學、婦科腫瘤、生殖內分泌與不孕症診療。'],
      ['精神科', '精神疾病的診斷標準（DSM）、藥物治療與心理治療。'],
      ['神經科', '中樞及周邊神經系統疾病、腦血管疾病、癲癇與頭痛。'],
      ['急診醫學', '急重症處置、創傷評估、毒物學與急救流程。'],
      ['醫療法規', '醫師法、醫療法、病人自主權利法等相關法規與倫理議題。'],
    ],
  },
  dental1: {
    title: '牙醫知識王',
    fullName: '牙醫師國考第一階段',
    shortName: '牙醫一階',
    studentType: '牙醫學生',
    years: '110 至 115',
    totalQ: 1600,
    examDesc: '牙醫師國考第一階段（一階）為考選部舉辦之專門職業及技術人員高等考試，每年舉行一至兩次，應考資格為完成基礎牙醫學課程之牙醫學系學生。',
    paperDesc: '考試分為兩卷，每卷各 80 題選擇題，合計 160 題。每題 1.25 分、每卷滿分 100 分，總分 200 分，及格標準為 96 分（60%）。',
    subjects: '牙醫解剖、口腔解剖、牙體形態、胚胎及組織學、口腔病理、牙科藥理、微生物及免疫學、口腔生理等基礎牙醫科目',
    mockDesc: '完整模擬兩卷，每題 1.25 分，96/200 及格',
    subjectDetails: [
      ['牙醫解剖學', '頭頸部解剖構造、顱骨、肌肉、神經與血管分布。'],
      ['口腔解剖學', '口腔內各組織結構、牙齒周圍組織、唾液腺構造。'],
      ['牙體形態學', '各類牙齒的外型特徵、萌發順序與齒列發育。'],
      ['口腔病理學', '口腔常見疾病的病理變化、口腔腫瘤分類與鑑別診斷。'],
      ['牙科藥理學', '牙科常用藥物的作用機轉、麻醉藥物與抗生素使用。'],
      ['微生物及免疫學', '口腔微生物生態、齲齒與牙周病相關致病菌。'],
    ],
  },
  dental2: {
    title: '牙醫知識王',
    fullName: '牙醫師國考第二階段',
    shortName: '牙醫二階',
    studentType: '牙醫學生',
    years: '110 至 115',
    totalQ: 3200,
    examDesc: '牙醫師國考第二階段（二階）為考選部舉辦之專門職業及技術人員高等考試，每年舉行一至兩次，應考資格為通過一階並完成臨床實習之牙醫學系學生。',
    paperDesc: '考試分為四卷，每卷各 80 題選擇題，合計 320 題。每題 1.25 分、每卷滿分 100 分，總分 400 分，及格標準為 192 分（60%）。',
    subjects: '口腔顎面外科、牙周病學、齒顎矯正、兒童牙科、牙髓病學、牙體復形、牙科材料、補綴學、口腔診斷、公共衛生等臨床牙醫科目',
    mockDesc: '完整模擬四卷，每題 1.25 分，192/400 及格',
    subjectDetails: [
      ['口腔顎面外科', '拔牙手術、顎骨骨折處理、口腔腫瘤手術與顎面重建。'],
      ['牙周病學', '牙周疾病的分類、診斷與治療計畫，牙周手術方式。'],
      ['齒顎矯正', '齒列不正的分類、矯正力學原理與治療計畫擬定。'],
      ['牙體復形', '齲齒的修復材料選擇、窩洞設計與直接/間接復形技術。'],
      ['補綴學', '固定補綴、活動補綴與全口補綴的設計原則與製作流程。'],
      ['兒童牙科', '兒童齲齒預防、行為管理與乳牙治療。'],
    ],
  },
  pharma1: {
    title: '藥學知識王',
    fullName: '藥師國考第一階段',
    shortName: '藥師一階',
    studentType: '藥學生',
    years: '110 至 115',
    totalQ: 2400,
    examDesc: '藥師國考第一階段（一階）為考選部舉辦之專門職業及技術人員高等考試，每年舉行一至兩次，應考資格為完成基礎藥學課程之藥學系學生。',
    paperDesc: '考試分為三卷，每卷各 80 題選擇題，合計 240 題，採及格制（總分 180 分以上通過，需每科達該科目滿分之五成）。',
    subjects: '藥理學、藥物化學、藥物分析、生藥學（含中藥學）、藥劑學、生物藥劑學等基礎藥學科目',
    mockDesc: '完整模擬三卷，180/240 及格制',
    subjectDetails: [
      ['藥理學', '各類藥物的作用機轉、藥效學與藥物動力學，受體理論與信號傳遞。'],
      ['藥物化學', '藥物的化學結構與活性關係（SAR）、藥物設計與代謝途徑。'],
      ['藥物分析', '藥物定性定量分析方法、儀器分析原理與藥典規範。'],
      ['生藥學', '天然藥物的來源、有效成分、品質管制與中藥基本理論。'],
      ['藥劑學', '劑型設計、製劑技術、藥物傳輸系統與穩定性試驗。'],
      ['生物藥劑學', '藥物吸收、分布、代謝與排泄（ADME）、生體可用率與生體相等性。'],
    ],
  },
  pharma2: {
    title: '藥學知識王',
    fullName: '藥師國考第二階段',
    shortName: '藥師二階',
    studentType: '藥學生',
    years: '110 至 115',
    totalQ: 2100,
    examDesc: '藥師國考第二階段（二階）為考選部舉辦之專門職業及技術人員高等考試，每年舉行一至兩次，應考資格為通過一階並完成實習之藥學系學生。',
    paperDesc: '考試分為三卷（藥物治療 80 題、調劑與臨床 80 題、法規 50 題），合計 210 題，採及格制（總分 180 分以上通過，需每科達該科目滿分之五成）。',
    subjects: '調劑學、臨床藥學、治療學、藥物治療學、藥事行政與法規等臨床藥學科目',
    mockDesc: '完整模擬三卷，180/240 及格制',
    subjectDetails: [
      ['調劑學', '處方判讀、調劑作業流程、藥物交互作用與配伍禁忌。'],
      ['臨床藥學', '藥物治療監測（TDM）、藥事照護計畫與臨床藥動學應用。'],
      ['藥物治療學', '各系統疾病的藥物治療指引、實證醫學與治療準則。'],
      ['藥事行政與法規', '藥事法、管制藥品管理條例、全民健保用藥規範與藥師執業相關法規。'],
    ],
  },
}

function ExamArticle({ exam }) {
  const c = EXAM_CONTENT[exam.id] || EXAM_CONTENT.doctor1
  return (
    <article className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 text-sm text-gray-500 leading-relaxed space-y-3">
      <h2 className="font-bold text-base text-medical-dark">關於{c.title}</h2>
      <p>
        {c.title}是專為<strong>{c.fullName}</strong>設計的免費題庫練習平台，收錄 {c.years} 年度超過 {c.totalQ} 題考古題，
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
        {c.subjectDetails.map(([name, desc]) => (
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
  const c = EXAM_CONTENT[examId]
  return c ? c.years.replace(/ /g, '') : '110至115'
}

function TutorialSection({ exam }) {
  const c = EXAM_CONTENT[exam.id] || EXAM_CONTENT.doctor1
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
  const { name, setName, coins, level, claimDailyBonus, loginStreak } = usePlayerStore()
  const [dailyClaimed, setDailyClaimed] = useState(false)
  const [dailyAmount, setDailyAmount] = useState(0)

  useEffect(() => {
    const amount = claimDailyBonus()
    if (amount) { setDailyClaimed(true); setDailyAmount(amount) }
  }, [])
  const { showBanner, isIOS, install, installPrompt, dismiss } = usePWA()
  const { getDueCount } = useBookmarks()
  const dueCount = getDueCount()
  const [devTaps, setDevTaps] = useState(0)
  const devTimer = useRef(null)
  const [devCoinsInput, setDevCoinsInput] = useState('')
  const handleDevTap = () => {
    setDevTaps(t => {
      const next = t + 1
      clearTimeout(devTimer.current)
      if (next >= 5) { setSheet('dev'); return 0 }
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
  const currentExam = EXAM_TYPES.find(e => e.id === exam) || EXAM_TYPES[0]

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
          <div className="relative text-6xl mb-3">{currentExam.icon}</div>
          <h1 className="relative text-white font-bold text-3xl tracking-tight mb-1">醫學知識王</h1>
          <button onClick={() => setSheet('exam')}
                  className="relative text-white/50 text-sm flex items-center gap-1 active:scale-95 transition-transform">
            {currentExam.name} · 即時對戰 <span className="text-white/30 text-xs">▼</span>
          </button>
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
            <h2 className="text-xl font-bold text-medical-dark text-center mb-1">選擇考試類別</h2>
            <p className="text-center text-gray-400 text-sm mb-4">切換不同國考題庫</p>
            <div className="grid grid-cols-2 gap-2.5">
              {EXAM_TYPES.map(e => (
                <button key={e.id}
                  onClick={() => { setExam(e.id); setSheet(null) }}
                  className={`rounded-2xl p-4 flex flex-col items-center gap-1.5 border-2 transition-all active:scale-95
                    ${exam === e.id ? 'border-medical-blue bg-medical-light shadow' : 'border-gray-100 bg-white'}`}>
                  <span className="text-3xl">{e.icon}</span>
                  <span className={`font-bold text-sm ${exam === e.id ? 'text-medical-blue' : 'text-medical-dark'}`}>{e.name}</span>
                </button>
              ))}
            </div>
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
          <button onClick={() => setSheet('exam')} className="text-left active:scale-95 transition-transform">
            <p className="text-white/50 text-xs font-medium tracking-widest mb-0.5 flex items-center gap-1">
              {currentExam.icon} {currentExam.name} <span className="text-white/30">▼</span>
            </p>
            <h1 className="text-white font-bold text-3xl tracking-tight leading-none" onClick={(e) => { e.stopPropagation(); handleDevTap() }}>知識王</h1>
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
            <p className="text-white font-bold text-sm">🎁 每日登入獎勵 +{dailyAmount} 金幣！</p>
            {loginStreak >= 2 && (
              <p className="text-amber-300/80 text-xs mt-1">🔥 連續登入 {loginStreak} 天{loginStreak >= 7 ? ' · 最高加成！' : loginStreak >= 5 ? ' · +150 加成' : loginStreak >= 3 ? ' · +100 加成' : ' · +50 加成'}</p>
            )}
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
          {[['📝','模擬考','歷屆/隨機模擬','/mock-exam'],
            ['📒','精華筆記',`${currentExam.papers?.length || 2}卷高頻考點`,'/notes'],
            ['🎯','自主練習','練習含AI對手','/practice'],
            ['📖','題庫瀏覽',`${getYearRange(exam)}年題庫`,'/browse'],
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
          <h2 className="text-xl font-bold text-medical-dark text-center mb-1">選擇考試類別</h2>
          <p className="text-center text-gray-400 text-sm mb-4">切換不同國考題庫</p>
          <div className="grid grid-cols-2 gap-2.5">
            {EXAM_TYPES.map(e => (
              <button key={e.id}
                onClick={() => { setExam(e.id); setSheet(null) }}
                className={`rounded-2xl p-4 flex flex-col items-center gap-1.5 border-2 transition-all active:scale-95
                  ${exam === e.id ? 'border-medical-blue bg-medical-light shadow' : 'border-gray-100 bg-white'}`}>
                <span className="text-3xl">{e.icon}</span>
                <span className={`font-bold text-sm ${exam === e.id ? 'text-medical-blue' : 'text-medical-dark'}`}>{e.name}</span>
              </button>
            ))}
          </div>
        </Sheet>
      )}

      <SupportSheets sheet={sheet} setSheet={setSheet} />

      {/* Dev panel — tap 知識王 5 times */}
      {sheet === 'dev' && (
        <Sheet onClose={() => setSheet(null)}>
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
