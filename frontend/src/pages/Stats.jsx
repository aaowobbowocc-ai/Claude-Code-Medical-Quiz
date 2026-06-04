/**
 * 我的數據 — 個人學習報告
 *
 * 取代原本沒人用的留言板入口。資料全部來自本機既有來源：
 *   - gameStore：等級/經驗/金幣/連續登入/暱稱/頭像/目前考試
 *   - accuracyStore：各科 correct/wrong/rate（getAllSubjects 已按弱→強排序）
 * 不需要動後端。圖表用純 SVG/CSS 自畫，不加依賴。
 */
import { useNavigate } from 'react-router-dom'
import { usePlayerStore, getLevelTitle } from '../store/gameStore'
import { useAccuracyStore } from '../store/accuracyStore'
import { getExamConfig } from '../config/examRegistry'
import AvatarText from '../components/AvatarText'
import Footer from '../components/Footer'

const EXP_PER_LEVEL = 300

function rateColor(rate) {
  if (rate >= 0.8) return { bar: '#10b981', text: 'text-emerald-600', bg: 'bg-emerald-50' } // 穩
  if (rate >= 0.6) return { bar: '#f59e0b', text: 'text-amber-600', bg: 'bg-amber-50' }       // 普
  return { bar: '#ef4444', text: 'text-red-500', bg: 'bg-red-50' }                              // 弱
}

/* ── 各科正確率雷達圖（純 SVG）──────────────────────────
 * 取作答最多的前 8 科避免太擠；rate 對應半徑，紅黃綠依整體弱強上色。 */
function RadarChart({ subjects }) {
  const pts = subjects.slice(0, 8)
  const n = pts.length
  if (n < 3) return null // 少於 3 科畫不出有意義的多邊形
  const cx = 110, cy = 105, R = 78
  const angle = i => (Math.PI * 2 * i) / n - Math.PI / 2
  const at = (i, r) => [cx + r * Math.cos(angle(i)), cy + r * Math.sin(angle(i))]
  const rings = [0.25, 0.5, 0.75, 1]
  const dataPoly = pts.map((s, i) => at(i, R * s.rate).join(',')).join(' ')
  const avgRate = pts.reduce((a, s) => a + s.rate, 0) / n
  const stroke = avgRate >= 0.8 ? '#10b981' : avgRate >= 0.6 ? '#f59e0b' : '#ef4444'

  return (
    <svg viewBox="0 0 220 215" className="w-full max-w-xs mx-auto block">
      {/* 同心多邊形格線 */}
      {rings.map((rg, ri) => (
        <polygon key={ri}
          points={pts.map((_, i) => at(i, R * rg).join(',')).join(' ')}
          fill="none" stroke="#e5e7eb" strokeWidth="1" />
      ))}
      {/* 軸線 + 標籤 */}
      {pts.map((s, i) => {
        const [ax, ay] = at(i, R)
        const [lx, ly] = at(i, R + 14)
        return (
          <g key={i}>
            <line x1={cx} y1={cy} x2={ax} y2={ay} stroke="#e5e7eb" strokeWidth="1" />
            <text x={lx} y={ly} fontSize="8" fontWeight="600" fill="#6b7280"
              textAnchor={Math.abs(lx - cx) < 5 ? 'middle' : lx > cx ? 'start' : 'end'}
              dominantBaseline="middle">
              {s.tag.length > 5 ? s.tag.slice(0, 5) : s.tag}
            </text>
          </g>
        )
      })}
      {/* 資料區塊 */}
      <polygon points={dataPoly} fill={stroke} fillOpacity="0.18" stroke={stroke} strokeWidth="2" />
      {pts.map((s, i) => {
        const [px, py] = at(i, R * s.rate)
        return <circle key={i} cx={px} cy={py} r="2.5" fill={stroke} />
      })}
    </svg>
  )
}

function StatCard({ value, label, sub }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 px-3 py-3 text-center">
      <div className="text-2xl font-extrabold text-medical-dark leading-tight">{value}</div>
      <div className="text-[11px] text-gray-500 mt-0.5">{label}</div>
      {sub && <div className="text-[10px] text-gray-400 mt-0.5">{sub}</div>}
    </div>
  )
}

function SubjectBar({ s }) {
  const c = rateColor(s.rate)
  const pct = Math.round(s.rate * 100)
  return (
    <div className="py-2">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-sm font-semibold text-medical-dark truncate pr-2">{s.tag}</span>
        <span className={`text-sm font-bold ${c.text} shrink-0`}>{pct}%</span>
      </div>
      <div className="h-2.5 rounded-full bg-gray-100 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500"
             style={{ width: `${pct}%`, background: c.bar }} />
      </div>
      <div className="text-[10px] text-gray-400 mt-0.5">{s.correct} / {s.total} 題</div>
    </div>
  )
}

export default function Stats() {
  const navigate = useNavigate()
  const { name, avatar, level, exp, coins, loginStreak, exam } = usePlayerStore()
  const getAllSubjects = useAccuracyStore(s => s.getAllSubjects)

  const subjects = getAllSubjects(exam) || []           // 已按弱→強排序
  const answered = subjects.filter(s => s.total > 0)
  const totalCorrect = subjects.reduce((a, s) => a + s.correct, 0)
  const totalWrong = subjects.reduce((a, s) => a + s.wrong, 0)
  const totalAnswered = totalCorrect + totalWrong
  const overallRate = totalAnswered ? Math.round((totalCorrect / totalAnswered) * 100) : 0
  const weakest = answered.filter(s => s.total >= 5).slice(0, 3) // 弱→強，取前 3 弱
  const radarSubjects = [...answered].sort((a, b) => b.total - a.total) // 雷達圖取作答最多的
  const masteredSubjects = answered.filter(s => s.rate >= 0.8 && s.total >= 5).length
  const ANSWER_TIERS = [100, 500, 1000, 3000, 10000]
  const nextAnswerTier = ANSWER_TIERS.find(t => totalAnswered < t) || ANSWER_TIERS[ANSWER_TIERS.length - 1]
  const STREAK_TIERS = [3, 7, 14, 30, 100]
  const nextStreakTier = STREAK_TIERS.find(t => (loginStreak || 0) < t) || STREAK_TIERS[STREAK_TIERS.length - 1]
  const title = getLevelTitle(level)
  const examName = getExamConfig(exam)?.name || ''
  const expPct = Math.min(100, Math.round((exp / EXP_PER_LEVEL) * 100))

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      <div className="px-4 pt-5 pb-2 flex-1 max-w-xl w-full mx-auto">
        <button onClick={() => navigate(-1)}
                className="text-medical-blue text-sm mb-3 active:opacity-70 font-bold">
          ‹ 返回
        </button>

        {/* ── 個人檔案頭 ─────────────────────────── */}
        <div className="bg-gradient-to-br from-medical-blue to-medical-accent rounded-3xl px-5 py-5 text-white shadow-md">
          <div className="flex items-center gap-3 mb-3">
            <AvatarText avatar={avatar || '👨‍⚕️'} size={48} className="text-4xl" />
            <div className="flex-1 min-w-0">
              <p className="font-bold text-xl leading-tight truncate">{name || '訪客'}</p>
              <p className="text-white/70 text-xs">Lv.{level} {title.icon} {title.title}{examName ? ` · ${examName}` : ''}</p>
            </div>
            <div className="text-right">
              <p className="text-white/60 text-[10px]">金幣</p>
              <p className="font-bold text-lg leading-tight">🪙 {coins}</p>
            </div>
          </div>
          <div className="w-full h-2 bg-white/25 rounded-full">
            <div className="h-full bg-white rounded-full transition-all duration-500" style={{ width: `${expPct}%` }} />
          </div>
          <p className="text-white/60 text-[10px] mt-1">經驗 {exp} / {EXP_PER_LEVEL}（距離下一級 {EXP_PER_LEVEL - exp}）</p>
        </div>

        {/* ── 總覽 ─────────────────────────────── */}
        <div className="grid grid-cols-3 gap-2.5 mt-4">
          <StatCard value={totalAnswered.toLocaleString('zh-TW')} label="累計答題" />
          <StatCard value={`${overallRate}%`} label="總正確率" sub={`對 ${totalCorrect} · 錯 ${totalWrong}`} />
          <StatCard value={loginStreak || 0} label="連續登入" sub="天" />
        </div>

        {totalAnswered === 0 ? (
          /* ── 空狀態 ── */
          <div className="bg-white rounded-2xl border border-gray-100 mt-4 py-10 text-center">
            <div className="text-5xl mb-3">📊</div>
            <p className="text-medical-dark font-bold">還沒有數據</p>
            <p className="text-gray-400 text-sm mt-1 mb-5">開始練習，這裡就會長出你的學習報告</p>
            <button onClick={() => navigate('/')}
                    className="px-7 py-3 rounded-2xl font-bold text-white active:scale-95 grad-cta">
              去練習
            </button>
          </div>
        ) : (
          <>
            {/* ── 弱科加強 ── */}
            {weakest.length > 0 && (
              <div className="bg-white rounded-2xl border border-red-100 mt-4 p-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="font-bold text-medical-dark">🎯 最需要加強</p>
                  <button onClick={() => navigate('/')}
                          className="text-xs font-bold text-medical-blue active:opacity-70">去練習 ›</button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {weakest.map(s => {
                    const c = rateColor(s.rate)
                    return (
                      <span key={s.tag} className={`text-xs font-bold px-2.5 py-1.5 rounded-lg ${c.bg} ${c.text}`}>
                        {s.tag} {Math.round(s.rate * 100)}%
                      </span>
                    )
                  })}
                </div>
              </div>
            )}

            {/* ── 里程碑（本機資料）── */}
            <div className="bg-white rounded-2xl border border-gray-100 mt-4 p-4">
              <p className="font-bold text-medical-dark mb-2.5">🏅 里程碑</p>
              <div className="grid grid-cols-3 gap-2.5">
                <div className="text-center">
                  <div className="text-xl font-extrabold text-medical-dark">{masteredSubjects}</div>
                  <div className="text-[10px] text-gray-500 mt-0.5">精通科目<br />(≥80%)</div>
                </div>
                <div className="text-center">
                  <div className="text-xl font-extrabold text-medical-dark">Lv.{level}</div>
                  <div className="text-[10px] text-gray-500 mt-0.5">目前等級</div>
                </div>
                <div className="text-center">
                  <div className="text-xl font-extrabold text-medical-dark">{loginStreak || 0}<span className="text-xs font-bold text-gray-400">/{nextStreakTier}</span></div>
                  <div className="text-[10px] text-gray-500 mt-0.5">連續登入<br />下個目標</div>
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-gray-50">
                <div className="flex items-baseline justify-between mb-1">
                  <span className="text-xs font-semibold text-gray-500">累計答題里程碑</span>
                  <span className="text-xs font-bold text-medical-blue">{totalAnswered} / {nextAnswerTier}</span>
                </div>
                <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                  <div className="h-full rounded-full bg-medical-blue transition-all duration-500"
                       style={{ width: `${Math.min(100, Math.round((totalAnswered / nextAnswerTier) * 100))}%` }} />
                </div>
              </div>
            </div>

            {/* ── 各科正確率（雷達圖 + 明細）── */}
            <div className="bg-white rounded-2xl border border-gray-100 mt-4 p-4">
              <p className="font-bold text-medical-dark mb-1">各科正確率</p>
              {radarSubjects.length >= 3 && (
                <>
                  <RadarChart subjects={radarSubjects} />
                  {radarSubjects.length > 8 && (
                    <p className="text-center text-[10px] text-gray-400 -mt-1 mb-1">雷達圖顯示作答最多的 8 科</p>
                  )}
                </>
              )}
              <p className="text-[11px] text-gray-400 mt-2 mb-1">明細（由弱到強）· 紅&lt;60% 黃60-80% 綠&gt;80%</p>
              <div className="divide-y divide-gray-50">
                {answered.map(s => <SubjectBar key={s.tag} s={s} />)}
              </div>
            </div>

            <p className="text-center text-[11px] text-gray-400 mt-4">
              數據統計自本機練習紀錄，換裝置或清除資料會重新計算
            </p>
          </>
        )}
      </div>
      <Footer />
    </div>
  )
}
