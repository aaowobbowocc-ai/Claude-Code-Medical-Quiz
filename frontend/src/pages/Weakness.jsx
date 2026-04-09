import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/gameStore'
import { useAccuracyStore } from '../store/accuracyStore'
import { getExamConfig, getAllTagNames, getStageStyle } from '../config/examRegistry'
import { getSubjectColor } from '../utils/subjectColors'

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

  const examConfig = getExamConfig(examType)
  const tagNames = getAllTagNames()
  const examName = examConfig?.name || '考試'

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
        <p className="text-white/60 text-sm mt-1">{examName} — 各科正確率一覽</p>
      </div>

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
    </div>
  )
}
