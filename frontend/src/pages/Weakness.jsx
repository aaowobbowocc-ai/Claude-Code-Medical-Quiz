import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/gameStore'
import { useAccuracyStore } from '../store/accuracyStore'
import { getExamConfig, getAllTagNames, getStageStyle } from '../config/examRegistry'
import { getSubjectColor } from '../utils/subjectColors'
import { getWrong, removeWrong, clearWrong, WRONG_BANK_MAX, persistRehydrated } from '../lib/wrongBank'
import { getFlags, removeFlag, clearFlags } from '../lib/flagBank'
import { rehydrateWrong } from '../lib/cdnQuestions'

const MIN_ANSWERS = 5

function gradeColor(rate, total) {
  if (total < MIN_ANSWERS) return { bg: '#F1F5F9', text: '#94A3B8', label: '不足' }
  if (rate >= 0.8) return { bg: '#DCFCE7', text: '#16A34A', label: '優秀' }
  if (rate >= 0.6) return { bg: '#FEF9C3', text: '#CA8A04', label: '普通' }
  return { bg: '#FEE2E2', text: '#DC2626', label: '弱科' }
}

function SubjectCard({ tag, data, tagNames }) {
  const displayName = tagNames[tag] || tag
  const total = data.correct + data.wrong
  const rate = total > 0 ? data.correct / total : 0
  const pct = Math.round(rate * 100)
  const grade = gradeColor(rate, total)
  const style = getStageStyle(tag)
  const color = getSubjectColor(displayName) || style?.color || '#64748B'

  return (
    <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 relative overflow-hidden">
      {/* Color accent bar */}
      <div className="absolute top-0 left-0 right-0 h-1" style={{ background: color }} />

      <div className="flex items-start gap-3 mt-1">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0"
             style={{ background: color + '20' }}>
          {style?.icon || '📝'}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-sm text-gray-800 truncate">{displayName}</p>
          <p className="text-xs text-gray-400 mt-0.5">{total} 題作答</p>
        </div>
        <div className="text-right shrink-0">
          {total >= MIN_ANSWERS ? (
            <p className="font-black text-xl" style={{ color: grade.text }}>{pct}%</p>
          ) : (
            <p className="text-sm font-bold text-gray-300">—</p>
          )}
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                style={{ background: grade.bg, color: grade.text }}>
            {grade.label}
          </span>
        </div>
      </div>

      {/* Progress bar */}
      {total >= MIN_ANSWERS && (
        <div className="mt-3 h-2 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all duration-500"
               style={{ width: `${pct}%`, background: grade.text }} />
        </div>
      )}

      {/* Detail stats */}
      {total > 0 && (
        <div className="flex gap-4 mt-2 text-[11px] text-gray-400">
          <span>✅ {data.correct}</span>
          <span>❌ {data.wrong}</span>
        </div>
      )}
    </div>
  )
}

export default function Weakness() {
  const navigate = useNavigate()
  const examType = usePlayerStore(s => s.exam) || 'doctor1'
  const allSubjects = useAccuracyStore(s => s.getAllSubjects(examType))
  const weakest = useAccuracyStore(s => s.getWeakest(examType, MIN_ANSWERS))
  const resetExam = useAccuracyStore(s => s.resetExam)
  const [showReset, setShowReset] = useState(false)
  const [tab, setTab] = useState('stats')   // 'stats' | 'wrong' | 'flag'
  const [wrongVer, setWrongVer] = useState(0)
  const [flagVer, setFlagVer] = useState(0)
  const [rehydrating, setRehydrating] = useState(false)
  const [practiceCount, setPracticeCount] = useState(0)   // 0 = 全部；否則本次只練前 N 題（最舊優先）

  const examConfig = getExamConfig(examType)
  const tagNames = getAllTagNames()
  const examName = examConfig?.name || '考試'

  const wrongQuestions = getWrong()
  const flagQuestions = (flagVer, getFlags())   // flagVer 觸發重讀

  const totalAnswered = allSubjects.reduce((s, e) => s + e.total, 0)
  const totalCorrect = allSubjects.reduce((s, e) => s + e.correct, 0)
  const overallRate = totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0

  // Sort: weak subjects first, then by total answers desc
  const sorted = [...allSubjects].sort((a, b) => {
    const aReady = a.total >= MIN_ANSWERS
    const bReady = b.total >= MIN_ANSWERS
    if (aReady && !bReady) return -1
    if (!aReady && bReady) return 1
    if (aReady && bReady) return a.rate - b.rate
    return b.total - a.total
  })

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      {/* Header */}
      <div className="px-4 pt-14 pb-5 grad-header">
        <button onClick={() => navigate('/')}
                className="text-white/50 text-sm mb-2 flex items-center gap-1 active:opacity-70">
          ‹ 返回
        </button>
        <h1 className="text-white font-bold text-2xl">弱點分析</h1>
        <p className="text-white/60 text-sm mt-1">
          {tab === 'stats' ? `${examName} — 各科正確率一覽`
            : tab === 'wrong' ? '答錯的題目自動累積，可隨時複習'
            : '考試中標記🚩的題目永久保存，可隨時回顧'}
        </p>
        {/* Tabs */}
        <div className="flex gap-2 mt-3">
          <button onClick={() => setTab('stats')}
            className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all active:scale-95 ${tab === 'stats' ? 'bg-white text-medical-blue shadow' : 'bg-white/15 text-white/60'}`}>
            📊 統計
          </button>
          <button onClick={() => setTab('wrong')}
            className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all active:scale-95 ${tab === 'wrong' ? 'bg-white text-red-500 shadow' : 'bg-white/15 text-white/60'}`}>
            🔥 錯題 ({wrongQuestions.length})
          </button>
          <button onClick={() => setTab('flag')}
            className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all active:scale-95 ${tab === 'flag' ? 'bg-white text-amber-500 shadow' : 'bg-white/15 text-white/60'}`}>
            🚩 標記 ({flagQuestions.length})
          </button>
        </div>
      </div>

      {tab === 'stats' && (
      <>
      {/* Overall stats */}
      {totalAnswered > 0 && (
        <div className="px-4 -mt-3 mb-4 relative z-10">
          <div className="bg-white rounded-2xl p-4 shadow-md border border-gray-100 flex items-center gap-4">
            <div className="w-16 h-16 rounded-full border-4 flex items-center justify-center shrink-0"
                 style={{ borderColor: overallRate >= 70 ? '#16A34A' : overallRate >= 50 ? '#CA8A04' : '#DC2626' }}>
              <span className="font-black text-xl"
                    style={{ color: overallRate >= 70 ? '#16A34A' : overallRate >= 50 ? '#CA8A04' : '#DC2626' }}>
                {overallRate}%
              </span>
            </div>
            <div className="flex-1">
              <p className="font-bold text-gray-800">整體正確率</p>
              <p className="text-xs text-gray-400 mt-0.5">
                共作答 {totalAnswered} 題 · 答對 {totalCorrect} 題
              </p>
              <p className="text-xs text-gray-400">
                已統計 {allSubjects.length} 科 · {weakest.length} 科達標 (≥{MIN_ANSWERS}題)
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 px-4 pb-8 overflow-y-auto">
        {totalAnswered === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 py-20">
            <span className="text-6xl">📊</span>
            <p className="text-gray-500 font-bold text-lg">還沒有作答記錄</p>
            <p className="text-gray-400 text-sm text-center leading-relaxed">
              去練習、模考或對戰後<br/>就能看到各科正確率分析
            </p>
            <button onClick={() => navigate('/practice')}
                    className="mt-4 px-8 py-3 rounded-2xl font-bold text-white grad-cta active:scale-95 transition-transform shadow-lg">
              開始練習
            </button>
          </div>
        ) : (
          <>
            {/* Weak subjects highlight */}
            {weakest.length > 0 && weakest[0].rate < 0.6 && (
              <div className="mb-4 bg-red-50 rounded-2xl p-4 border border-red-100">
                <p className="font-bold text-red-700 text-sm mb-2">
                  需加強的科目 ({weakest.filter(w => w.rate < 0.6).length} 科)
                </p>
                <div className="flex flex-wrap gap-2">
                  {weakest.filter(w => w.rate < 0.6).slice(0, 5).map(w => (
                    <span key={w.tag}
                          className="text-xs font-bold px-2.5 py-1 rounded-full bg-red-100 text-red-600">
                      {tagNames[w.tag] || w.tag} {Math.round(w.rate * 100)}%
                    </span>
                  ))}
                </div>
                <button onClick={() => navigate('/practice')}
                        className="mt-3 w-full py-2.5 rounded-xl font-bold text-sm text-white bg-red-500 active:scale-95 transition-transform">
                  練習弱科
                </button>
              </div>
            )}

            {/* All subjects grid */}
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">
              各科正確率
            </p>
            <div className="grid grid-cols-1 gap-3">
              {sorted.map(s => (
                <SubjectCard key={s.tag} tag={s.tag} data={s} tagNames={tagNames} />
              ))}
            </div>

            {/* Reset */}
            <div className="mt-8 text-center">
              {!showReset ? (
                <button onClick={() => setShowReset(true)}
                        className="text-xs text-gray-300 active:text-gray-500">
                  重置數據
                </button>
              ) : (
                <div className="bg-white rounded-2xl p-4 border border-gray-200 shadow-sm">
                  <p className="text-sm font-bold text-gray-700 mb-2">確定重置 {examName} 的正確率數據？</p>
                  <p className="text-xs text-gray-400 mb-3">此操作無法還原</p>
                  <div className="flex gap-2">
                    <button onClick={() => setShowReset(false)}
                            className="flex-1 py-2 rounded-xl text-sm font-bold bg-gray-100 text-gray-600 active:scale-95">
                      取消
                    </button>
                    <button onClick={() => { resetExam(examType); setShowReset(false) }}
                            className="flex-1 py-2 rounded-xl text-sm font-bold bg-red-500 text-white active:scale-95">
                      確定重置
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      </>
      )}

      {/* ── 錯題夾 tab ─────────────────── */}
      {tab === 'wrong' && (
        <div className="flex-1 px-4 pt-4 pb-8 overflow-y-auto">
          {wrongQuestions.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-20">
              <span className="text-6xl">🎉</span>
              <p className="text-gray-500 font-bold">還沒有錯題</p>
              <p className="text-gray-400 text-sm text-center leading-relaxed">
                做模擬考 / 練習 / 對戰<br/>答錯的題目會自動累積到這裡
              </p>
            </div>
          ) : (
            <>
              {/* 本次訂正題數選擇（回饋：一次全部訂正太累，可分批）— 從最舊的題目開始 */}
              {wrongQuestions.length > 20 && (
                <div className="mb-2">
                  <p className="text-xs text-gray-400 mb-1.5">本次要練習幾題？（從最早的錯題開始）</p>
                  <div className="flex gap-1.5 flex-wrap">
                    {[20, 50, 100].filter(n => n < wrongQuestions.length).map(n => (
                      <button key={n} onClick={() => setPracticeCount(n)}
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold border active:scale-95 transition-all ${practiceCount === n ? 'bg-orange-500 text-white border-orange-500' : 'bg-white text-gray-600 border-gray-200'}`}>
                        {n} 題
                      </button>
                    ))}
                    <button onClick={() => setPracticeCount(0)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold border active:scale-95 transition-all ${practiceCount === 0 ? 'bg-orange-500 text-white border-orange-500' : 'bg-white text-gray-600 border-gray-200'}`}>
                      全部 ({wrongQuestions.length})
                    </button>
                  </div>
                </div>
              )}
              <button disabled={rehydrating}
                onClick={async () => {
                  // 本次練習題數：選了 N 就取最舊 N 題，否則全部
                  const n = practiceCount > 0 ? Math.min(practiceCount, wrongQuestions.length) : wrongQuestions.length
                  const batch = wrongQuestions.slice(0, n)
                  // 錯題練習收費：一題 2 金幣（鞏固弱點的付費練習）
                  const cost = n * 2
                  const { spendCoins, coins } = usePlayerStore.getState()
                  if (!spendCoins(cost)) {
                    if (confirm(`金幣不足！練習錯題需要 ${cost} 金幣（${n} 題 × 2 🪙），目前只有 ${coins} 金幣\n\n要去賺金幣嗎？`)) navigate('/?reward=1')
                    return
                  }
                  setRehydrating(true)
                  const fresh = await rehydrateWrong(batch, examType).catch(() => batch)
                  persistRehydrated(fresh)
                  setRehydrating(false)
                  navigate('/practice', { state: { wrongPractice: fresh } })
                }}
                className="w-full py-3 rounded-2xl font-bold text-white text-sm shadow active:scale-95 mb-2 disabled:opacity-60"
                style={{ background: 'linear-gradient(135deg,#f97316,#ef4444)' }}>
                {rehydrating ? '載入最新題目…' : (() => { const n = practiceCount > 0 ? Math.min(practiceCount, wrongQuestions.length) : wrongQuestions.length; return `✍️ 練習錯題（${n} 題 · 扣 ${n * 2} 🪙）` })()}
              </button>
              <div className="flex items-center gap-2 mb-3">
                <button disabled={rehydrating}
                  onClick={async () => {
                    setRehydrating(true)
                    const fresh = await rehydrateWrong(wrongQuestions, examType).catch(() => wrongQuestions)
                    persistRehydrated(fresh)
                    setRehydrating(false)
                    navigate('/review', { state: { questions: fresh, stage: '錯題夾' } })
                  }}
                  className="flex-1 py-3 rounded-2xl font-bold text-white text-sm shadow active:scale-95 disabled:opacity-60"
                  style={{ background: '#EF4444' }}>
                  📋 檢討（看答案解析）
                </button>
                <button onClick={() => {
                    if (confirm(`確定清空錯題夾？目前累積 ${wrongQuestions.length} 題`)) {
                      clearWrong(); setWrongVer(v => v + 1)
                    }
                  }}
                  className="px-3 py-3 rounded-2xl text-xs text-gray-400 bg-white border border-gray-200 active:scale-95">
                  清空
                </button>
              </div>
              <p className="text-xs text-gray-400 mb-3">
                自動累積（最多 {WRONG_BANK_MAX} 題，超過會移除最舊的）
              </p>

              {/* 錯題科目分布（回饋：讓使用者知道常錯哪些主題）*/}
              {(() => {
                const dist = {}
                for (const q of wrongQuestions) {
                  const k = q.subject_name || q.subject || '未分類'
                  dist[k] = (dist[k] || 0) + 1
                }
                const rows = Object.entries(dist).sort((a, b) => b[1] - a[1])
                if (rows.length < 2) return null   // 只有一科就不用分布圖
                const max = rows[0][1]
                return (
                  <div className="bg-white rounded-2xl border border-gray-100 px-4 py-3 shadow-sm mb-3">
                    <p className="text-sm font-bold text-medical-dark mb-2.5">📊 錯題科目分布</p>
                    <div className="flex flex-col gap-2">
                      {rows.map(([name, n]) => (
                        <div key={name} className="flex items-center gap-2">
                          <span className="text-xs text-gray-600 w-20 shrink-0 truncate text-right">{name}</span>
                          <div className="flex-1 h-4 bg-gray-100 rounded-full overflow-hidden">
                            <div className="h-full rounded-full transition-all" style={{ width: `${(n / max) * 100}%`, background: getSubjectColor(name) }} />
                          </div>
                          <span className="text-xs font-bold text-gray-500 w-6 shrink-0">{n}</span>
                        </div>
                      ))}
                    </div>
                    <p className="text-[11px] text-gray-400 mt-2.5">最常錯：<span className="font-bold text-red-500">{rows[0][0]}</span>（{rows[0][1]} 題）— 建議優先加強</p>
                  </div>
                )
              })()}

              <div className="flex flex-col gap-2">
                {wrongQuestions.map((q, i) => (
                  <div key={q.id || i} className="bg-white rounded-2xl border border-red-100 px-4 py-3 shadow-sm">
                    <div className="flex items-center gap-2 mb-1.5">
                      {q.subject_name && (
                        <span className="text-[10px] font-semibold text-white px-2 py-0.5 rounded-full"
                              style={{ background: getSubjectColor(q.subject_name) }}>
                          {q.subject_name}
                        </span>
                      )}
                      {q.roc_year && (
                        <span className="text-[10px] text-gray-400">{q.roc_year}年{q.session || ''}</span>
                      )}
                      <span className="flex-1" />
                      <button onClick={() => { removeWrong(q); setWrongVer(v => v + 1) }}
                        className="text-xs text-gray-300 active:text-red-400" title="從錯題夾移除">✕</button>
                    </div>
                    <p className="text-sm text-gray-700 line-clamp-2">{q.question}</p>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── 標記夾 tab ─────────────────── */}
      {tab === 'flag' && (
        <div className="flex-1 px-4 pt-4 pb-8 overflow-y-auto">
          {flagQuestions.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-20">
              <span className="text-6xl">🏳️</span>
              <p className="text-gray-500 font-bold">還沒有標記題</p>
              <p className="text-gray-400 text-sm text-center leading-relaxed">
                模擬考作答時點「🏳️ 標記不確定」<br/>交卷後就會永久收進這裡
              </p>
            </div>
          ) : (
            <>
              <button
                onClick={() => navigate('/review', { state: { questions: flagQuestions, stage: '標記夾' } })}
                className="w-full py-3 rounded-2xl font-bold text-white text-sm shadow active:scale-95 mb-2"
                style={{ background: 'linear-gradient(135deg,#f59e0b,#d97706)' }}>
                📋 檢討標記題（看答案解析 · {flagQuestions.length} 題）
              </button>
              <div className="flex items-center justify-end mb-3">
                <button onClick={() => {
                    if (confirm(`確定清空標記夾？目前 ${flagQuestions.length} 題`)) {
                      clearFlags(); setFlagVer(v => v + 1)
                    }
                  }}
                  className="px-3 py-2 rounded-2xl text-xs text-gray-400 bg-white border border-gray-200 active:scale-95">
                  清空
                </button>
              </div>
              <p className="text-xs text-gray-400 mb-3">
                你手動標記的題目（不論對錯），最多保留 200 題
              </p>
              <div className="flex flex-col gap-2">
                {flagQuestions.map((q, i) => (
                  <div key={q.id || i} className="bg-white rounded-2xl border border-amber-100 px-4 py-3 shadow-sm">
                    <div className="flex items-center gap-2 mb-1.5">
                      {q.subject_name && (
                        <span className="text-[10px] font-semibold text-white px-2 py-0.5 rounded-full"
                              style={{ background: getSubjectColor(q.subject_name) }}>
                          {q.subject_name}
                        </span>
                      )}
                      {q.correct === true && <span className="text-[10px] text-green-600 font-bold">✓ 當時答對</span>}
                      {q.correct === false && <span className="text-[10px] text-red-500 font-bold">✗ 當時答錯</span>}
                      {q.roc_year && (
                        <span className="text-[10px] text-gray-400">{q.roc_year}年{q.session || ''}</span>
                      )}
                      <span className="flex-1" />
                      <button onClick={() => { removeFlag(q); setFlagVer(v => v + 1) }}
                        className="text-xs text-gray-300 active:text-red-400" title="從標記夾移除">✕</button>
                    </div>
                    <p className="text-sm text-gray-700 line-clamp-2">{q.question}</p>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
