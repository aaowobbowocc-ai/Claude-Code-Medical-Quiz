import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/gameStore'
import { getExamTypes, getAllTagNames } from '../config/examRegistry'
import SmartBanner from '../components/SmartBanner'
import { useAccuracyStore } from '../store/accuracyStore'
import QuestionImages from '../components/QuestionImages'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

// TAG_NAMES is now loaded from exam-configs via getAllTagNames()

function getExamConfig(examType) {
  const types = getExamTypes()
  const et = types.find(e => e.id === examType) || types[0]
  const isWeighted = et.papers.some(p => p.pointsPerQ && p.pointsPerQ !== 1)
  return {
    papers: et.papers,
    totalPass: et.passScore,
    totalPoints: et.totalPoints || et.totalQ, // 300 for pharma, totalQ for others
    singlePass: Math.round(et.papers[0]?.count * 0.6) || 60,
    examName: et.name,
    isWeighted,
  }
}

// Calculate weighted score for a paper result
function calcPaperScore(correct, total, paper) {
  if (paper?.pointsPerQ && paper.pointsPerQ !== 1) {
    return +(correct * paper.pointsPerQ).toFixed(2)
  }
  return correct
}

function calcTotalScore(papers, examPapers) {
  return papers.reduce((sum, p, i) => {
    const paper = examPapers?.[i]
    return sum + calcPaperScore(p.correct, p.total, paper)
  }, 0)
}

const DEFAULT_TIME_LIMIT = 120 // minutes
function getPaperTimeLimit(paper) {
  return (paper?.timeLimit || DEFAULT_TIME_LIMIT) * 60 // seconds
}
function getPaperTimeLimitMin(paper) {
  return paper?.timeLimit || DEFAULT_TIME_LIMIT
}
function getTimeLimitText(papers) {
  const times = [...new Set(papers.map(p => getPaperTimeLimitMin(p)))]
  return times.length === 1 ? `各 ${times[0]} 分鐘` : papers.map(p => `${p.name} ${getPaperTimeLimitMin(p)}分鐘`).join('、')
}

// Check if user's answer is correct (supports multi-answer "A,B" and voided "送分"/empty)
function isAnswerCorrect(userAnswer, correctAnswer) {
  if (!correctAnswer || correctAnswer === '送分') return true // voided → always correct
  if (correctAnswer.includes(',')) {
    return correctAnswer.split(',').map(s => s.trim()).includes(userAnswer)
  }
  return userAnswer === correctAnswer
}

const OPTION_COLORS = { A: '#3B82F6', B: '#10B981', C: '#F59E0B', D: '#EF4444' }

// ── Fee calculation ──────────────────────────────────────────────
// 完整模考：總題數 × 4，單科：該卷題數 × 5
function getFullExamFee(papers) {
  return papers.reduce((s, p) => s + p.count, 0) * 4
}
function getSingleExamFee(paper) {
  return paper.count * 5
}

function ExamSetup({ onStart, onStartFull, onStartHistorical, onBack, coins }) {
  const examType = usePlayerStore(s => s.exam) || 'doctor1'
  const { papers: PAPERS, totalPass: TOTAL_PASS, totalPoints: TOTAL_POINTS, examName, isWeighted } = getExamConfig(examType)
  const FULL_EXAM_FEE = getFullExamFee(PAPERS)
  const [tab, setTab] = useState('historical') // 'historical' | 'random'
  const [examYears, setExamYears] = useState([])
  const [loadingYears, setLoadingYears] = useState(true)
  const [selectedExam, setSelectedExam] = useState(null) // { roc_year, session, papers }

  useEffect(() => {
    const examType = usePlayerStore.getState().exam || 'doctor1'
    fetch(`${BACKEND}/questions/exam-years?exam=${examType}`)
      .then(r => r.json())
      .then(data => { setExamYears(data); setLoadingYears(false) })
      .catch(() => setLoadingYears(false))
  }, [])

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      <div className="px-4 pt-12 pb-4 grad-header">
        <div className="flex items-center gap-3 mb-3">
          <button onClick={selectedExam ? () => setSelectedExam(null) : onBack} className="text-white/60 text-2xl leading-none">‹</button>
          <div>
            <h1 className="text-white font-bold text-2xl">📝 模擬國考</h1>
            <p className="text-white/60 text-sm mt-1">依照真實國考規則模擬</p>
          </div>
        </div>
        {/* Tab switcher */}
        <div className="flex bg-white/15 rounded-xl p-1">
          <button onClick={() => { setTab('historical'); setSelectedExam(null) }}
            className={`flex-1 py-2 rounded-lg text-sm font-bold transition-all ${tab === 'historical' ? 'bg-white text-medical-blue shadow' : 'text-white/70'}`}>
            📜 歷屆考題
          </button>
          <button onClick={() => { setTab('random'); setSelectedExam(null) }}
            className={`flex-1 py-2 rounded-lg text-sm font-bold transition-all ${tab === 'random' ? 'bg-white text-medical-blue shadow' : 'text-white/70'}`}>
            🎲 隨機模擬
          </button>
        </div>
      </div>

      <div className="flex-1 px-4 py-4 flex flex-col gap-3 overflow-y-auto">
        {tab === 'historical' ? (
          /* ── Historical exam selection ── */
          selectedExam ? (
            /* Paper selection for chosen exam */
            <>
              <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 text-center">
                <p className="text-2xl mb-1">📜</p>
                <p className="font-bold text-lg text-medical-dark">{selectedExam.roc_year} 年{selectedExam.session}</p>
                <p className="text-gray-400 text-xs mt-1">原卷題目 · 按照國考原始題序出題</p>
              </div>

              {/* Full exam */}
              <button onClick={() => onStartHistorical(selectedExam.roc_year, selectedExam.session, true)}
                className={`w-full text-left rounded-2xl px-5 py-5 border-2 shadow transition-all active:scale-[0.97] ${coins >= FULL_EXAM_FEE ? 'border-medical-blue bg-blue-50' : 'border-gray-200 bg-gray-50 opacity-60'}`}>
                <div className="flex items-center gap-3">
                  <span className="text-3xl">📋</span>
                  <div className="flex-1">
                    <p className="font-bold text-lg text-medical-blue">完整模擬考</p>
                    <p className="text-gray-500 text-xs mt-1">{PAPERS.map(p => p.name).join(' + ')}，共 {PAPERS.reduce((s,p) => s+p.count, 0)} 題</p>
                    <p className="text-gray-400 text-xs">{getTimeLimitText(PAPERS)}，{TOTAL_PASS}/{TOTAL_POINTS || PAPERS.reduce((s,p)=>s+p.count,0)} 及格</p>
                  </div>
                  <span className="text-sm font-bold text-amber-600 bg-amber-50 px-2.5 py-1 rounded-full whitespace-nowrap">🪙 {FULL_EXAM_FEE}</span>
                </div>
              </button>

              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-gray-200" />
                <span className="text-gray-400 text-xs">或單獨考一卷</span>
                <div className="flex-1 h-px bg-gray-200" />
              </div>

              {/* Single paper with distribution */}
              {selectedExam.papers.map((p, pi) => {
                const paperDef = PAPERS[pi]
                if (!paperDef) return null
                const singleFee = getSingleExamFee(paperDef)
                const distText = Object.entries(p.distribution || {})
                  .map(([tag, cnt]) => `${getAllTagNames()[tag] || tag} ${cnt}`)
                  .join('、')
                return (
                  <button key={pi} onClick={() => onStartHistorical(selectedExam.roc_year, selectedExam.session, false, paperDef)}
                    className={`w-full text-left rounded-2xl px-5 py-4 border-2 transition-all active:scale-[0.97] ${coins >= singleFee ? 'border-gray-100 bg-white' : 'border-gray-100 bg-gray-50 opacity-60'}`}>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-bold text-lg text-medical-dark">{p.name}</p>
                        <p className="text-gray-400 text-xs mt-1">{distText}</p>
                        <p className="text-gray-300 text-xs">{p.total} 題 / {getPaperTimeLimitMin(paperDef)} 分鐘</p>
                      </div>
                      <span className="text-sm font-bold text-amber-600 bg-amber-50 px-2.5 py-1 rounded-full whitespace-nowrap">🪙 {singleFee}</span>
                    </div>
                  </button>
                )
              })}
            </>
          ) : (
            /* Year/session list */
            loadingYears ? (
              <div className="flex flex-col gap-3">
                {[0,1,2,3].map(i => (
                  <div key={i} className="bg-white rounded-2xl p-4 shadow-sm animate-pulse">
                    <div className="h-5 bg-gray-200 rounded w-1/3 mb-2" />
                    <div className="h-3 bg-gray-200 rounded w-2/3" />
                  </div>
                ))}
              </div>
            ) : (
              examYears.map(exam => (
                <button key={`${exam.roc_year}_${exam.session}`}
                  onClick={() => setSelectedExam(exam)}
                  className="w-full text-left bg-white rounded-2xl px-5 py-4 border border-gray-100 shadow-sm transition-all active:scale-[0.97]">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-bold text-lg text-medical-dark">{exam.roc_year} 年{exam.session}</p>
                      <p className="text-gray-400 text-xs mt-1">
                        {exam.papers.map(p => `${p.name} ${p.total}題`).join(' + ')}
                      </p>
                    </div>
                    <span className="text-gray-300 text-xl">›</span>
                  </div>
                </button>
              ))
            )
          )
        ) : (
          /* ── Random mode ── */
          <>
            <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 text-center">
              <p className="text-2xl mb-1">🎲</p>
              <p className="font-bold text-medical-dark">隨機模擬考</p>
              <p className="text-gray-400 text-xs mt-1">從所有年份題庫隨機抽題，按照國考各科比例出題</p>
            </div>

            <button onClick={onStartFull}
              className={`w-full text-left rounded-2xl px-5 py-5 border-2 shadow transition-all active:scale-[0.97] ${coins >= FULL_EXAM_FEE ? 'border-medical-blue bg-blue-50' : 'border-gray-200 bg-gray-50 opacity-60'}`}>
              <div className="flex items-center gap-3">
                <span className="text-3xl">📋</span>
                <div className="flex-1">
                  <p className="font-bold text-lg text-medical-blue">完整模擬考</p>
                  <p className="text-gray-500 text-xs mt-1">{PAPERS.map(p => p.name).join(' + ')}，共 {PAPERS.reduce((s,p) => s+p.count, 0)} 題</p>
                  <p className="text-gray-400 text-xs">{getTimeLimitText(PAPERS)}，{TOTAL_PASS}/{TOTAL_POINTS || PAPERS.reduce((s,p)=>s+p.count,0)} 及格</p>
                </div>
                <span className="text-sm font-bold text-amber-600 bg-amber-50 px-2.5 py-1 rounded-full whitespace-nowrap">🪙 {FULL_EXAM_FEE}</span>
              </div>
            </button>

            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-gray-200" />
              <span className="text-gray-400 text-xs">或單獨考一卷</span>
              <div className="flex-1 h-px bg-gray-200" />
            </div>

            {PAPERS.map(p => {
              const singleFee = getSingleExamFee(p)
              return (
              <button key={p.id} onClick={() => onStart(p)}
                className={`w-full text-left rounded-2xl px-5 py-4 border-2 transition-all active:scale-[0.97] ${coins >= singleFee ? 'border-gray-100 bg-white' : 'border-gray-100 bg-gray-50 opacity-60'}`}>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-bold text-lg text-medical-dark">{p.name}</p>
                    <p className="text-gray-400 text-xs mt-1">{p.subjects}</p>
                    <p className="text-gray-300 text-xs">{p.count} 題{p.pointsPerQ && p.pointsPerQ !== 1 ? ` · 每題 ${p.pointsPerQ} 分` : ''} / {getPaperTimeLimitMin(p)} 分鐘</p>
                  </div>
                  <span className="text-sm font-bold text-amber-600 bg-amber-50 px-2.5 py-1 rounded-full whitespace-nowrap">🪙 {singleFee}</span>
                </div>
              </button>
              )
            })}
          </>
        )}

        <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
          <p className="text-sm font-bold text-gray-700 mb-2">{examName}規則</p>
          <div className="text-xs text-gray-500 space-y-1.5">
            <p>📋 {PAPERS.length} 張考卷{PAPERS.every(p => p.count === PAPERS[0].count) ? `各 ${PAPERS[0].count} 題` : `（${PAPERS.map(p => p.count + '題').join('/')}）`}，共 {PAPERS.reduce((s,p) => s+p.count, 0)} 題</p>
            <p>⏱️ {getTimeLimitText(PAPERS)}</p>
            {isWeighted ? (
              <p>✅ 每科滿分 100 分，{PAPERS.length} 科合計 {TOTAL_POINTS} 分</p>
            ) : (
              <p>✅ 每題 1 分，合計 {PAPERS.reduce((s,p) => s+p.count, 0)} 分</p>
            )}
            <p>🎯 及格：總分 {TOTAL_PASS} 分（60%），不設單科低標</p>
            <p>⚠️ 任一科零分者不予錄取（考試規則第 9 條）</p>
            <p>❌ 答錯不倒扣，不會就猜！</p>
            <p>📌 可跳題作答，最後統一交卷</p>
          </div>
        </div>

        <div className="bg-amber-50 dark:bg-amber-950/40 rounded-2xl p-4 shadow-sm border border-amber-100 dark:border-amber-800/50">
          <p className="text-sm font-bold text-amber-700 dark:text-amber-300 mb-2">🪙 金幣獎勵規則</p>
          <div className="text-xs text-amber-900/70 dark:text-amber-200/80 space-y-1.5">
            <p>📋 完整模考通過：獎勵 = 題數 × 1.5</p>
            <p>📄 單科通過（≥60%）：獎勵 = 題數 × 1</p>
            <p>❌ 未通過：無獎勵</p>
            <p>💡 入場費：完整模考 題數×4、單科 題數×5</p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Exam in progress ─────────────────────────────────────────────
function ExamInProgress({ paper, questions, onFinish, onBack }) {
  const [answers, setAnswers] = useState({})
  const [qIdx, setQIdx] = useState(0)
  const [timeLeft, setTimeLeft] = useState(getPaperTimeLimit(paper))
  const [showNav, setShowNav] = useState(false)
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false)
  const timerRef = useRef(null)
  const answersRef = useRef(answers)
  answersRef.current = answers

  useEffect(() => {
    timerRef.current = setInterval(() => {
      setTimeLeft(t => {
        if (t <= 1) { clearInterval(timerRef.current); onFinish(answersRef.current); return 0 }
        return t - 1
      })
    }, 1000)
    return () => clearInterval(timerRef.current)
  }, [])

  const selectAnswer = (letter) => {
    navigator.vibrate?.(15)
    setAnswers(prev => ({ ...prev, [qIdx]: letter }))
  }

  const answeredCount = Object.keys(answers).length
  const q = questions[qIdx]
  const mm = Math.floor(timeLeft / 60)
  const ss = timeLeft % 60
  const timeStr = `${mm}:${ss.toString().padStart(2, '0')}`
  const timeUrgent = timeLeft < 300

  const handleSubmit = () => {
    setShowSubmitConfirm(true)
  }
  const confirmSubmit = () => {
    clearInterval(timerRef.current)
    onFinish(answers)
  }

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      <div className="sticky top-0 z-10 grad-header px-4 pt-12 pb-3">
        <div className="flex items-center justify-between text-white text-xs mb-1.5">
          <button onClick={() => { if (confirm('確定要離開考試嗎？本卷進度將不會保存。')) { clearInterval(timerRef.current); onBack() } }}
            className="text-white/60 text-lg leading-none mr-2">‹</button>
          <span className="flex-1">{paper.name}</span>
          <span className={timeUrgent ? 'text-red-300 font-bold animate-pulse' : ''}>{timeStr}</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex-1 h-2 bg-white/20 rounded-full overflow-hidden">
            <div className="h-full bg-white/70 rounded-full transition-all duration-300"
                 style={{ width: `${(answeredCount / questions.length) * 100}%` }} />
          </div>
          <span className="text-white text-xs font-bold">{answeredCount}/{questions.length}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="bg-white rounded-2xl p-4 mb-4 shadow-sm">
          <p className="text-xs text-gray-400 mb-2">
            第 {qIdx + 1} / {questions.length} 題{q.subject_name ? `　·　${q.subject_name}` : ''}
          </p>
          <p className="text-gray-800 font-medium leading-relaxed text-sm">{q.question}</p>
          <QuestionImages images={q.images} imageUrl={q.image_url} incomplete={q.incomplete} />
        </div>
        <div className="flex flex-col gap-2.5">
          {Object.entries(q.options).map(([letter, text]) => {
            const selected = answers[qIdx] === letter
            return (
              <button key={letter} onClick={() => selectAnswer(letter)}
                className={`flex items-start gap-3 px-4 py-3.5 rounded-2xl border-2 text-sm text-left transition-all active:scale-95 shadow-sm
                  ${selected ? 'border-medical-blue bg-blue-50' : 'bg-white border-gray-100'}`}>
                <span className="font-bold w-5 shrink-0 text-base" style={{ color: OPTION_COLORS[letter] }}>{letter}</span>
                <span className={`flex-1 leading-snug ${selected ? 'text-medical-blue font-medium' : 'text-gray-700'}`}>{text}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="sticky bottom-0 bg-white border-t border-gray-100 px-4 py-3 flex items-center gap-3">
        <button onClick={() => setQIdx(i => Math.max(0, i - 1))} disabled={qIdx === 0}
          className="px-4 py-3 rounded-xl font-bold text-sm bg-gray-100 text-gray-600 disabled:opacity-30 active:scale-95">
          ‹ 上一題
        </button>
        <button onClick={() => setShowNav(!showNav)}
          className="flex-1 py-3 rounded-xl font-bold text-sm bg-medical-ice text-medical-dark border border-gray-200 active:scale-95">
          🗂️ 題目導覽
        </button>
        {qIdx < questions.length - 1 ? (
          <button onClick={() => setQIdx(i => i + 1)}
            className="px-4 py-3 rounded-xl font-bold text-sm text-white grad-cta active:scale-95">
            下一題 ›
          </button>
        ) : (
          <button onClick={handleSubmit}
            className="px-4 py-3 rounded-xl font-bold text-sm text-white bg-red-500 active:scale-95">
            交卷
          </button>
        )}
      </div>

      {showNav && (
        <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={() => setShowNav(false)}>
          <div className="w-full max-w-[430px] bg-white rounded-t-3xl px-5 pb-8 pt-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-4" />
            <div className="flex items-center justify-between mb-3">
              <p className="font-bold text-gray-700">題目導覽</p>
              <button onClick={() => { setShowNav(false); handleSubmit() }} className="text-sm font-bold text-red-500 active:scale-95">交卷 →</button>
            </div>
            <div className="grid grid-cols-10 gap-1.5">
              {questions.map((_, i) => (
                <button key={i} onClick={() => { setQIdx(i); setShowNav(false) }}
                  className={`w-full aspect-square rounded-lg text-xs font-bold flex items-center justify-center transition-all
                    ${i === qIdx ? 'ring-2 ring-medical-blue' : ''}
                    ${answers[i] ? 'bg-medical-blue text-white' : 'bg-gray-100 text-gray-400'}`}>
                  {i + 1}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {showSubmitConfirm && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center px-6" onClick={() => setShowSubmitConfirm(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-[340px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <p className="text-center text-3xl mb-3">📝</p>
            <p className="font-bold text-lg text-center text-medical-dark mb-2">確認交卷？</p>
            <div className="bg-gray-50 rounded-xl p-3 mb-4 text-sm text-center space-y-1">
              <p className="text-gray-700">已作答 <strong className="text-medical-blue">{answeredCount}</strong> / {questions.length} 題</p>
              {answeredCount < questions.length && (
                <p className="text-amber-600 font-medium">⚠️ 還有 {questions.length - answeredCount} 題未作答</p>
              )}
            </div>
            <div className="flex gap-3">
              <button onClick={() => setShowSubmitConfirm(false)}
                className="flex-1 py-3 rounded-xl font-bold text-sm bg-gray-100 text-gray-600 active:scale-95">
                繼續作答
              </button>
              <button onClick={confirmSubmit}
                className="flex-1 py-3 rounded-xl font-bold text-sm text-white bg-red-500 active:scale-95">
                確認交卷
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Intermission: ask to continue Paper 2 ────────────────────────
function Intermission({ paper1Result, onContinue, onFinishSingle, nextPaperName, completedCount, totalPapers, paperConfig }) {
  const { correct, total, timeUsed, paperName } = paper1Result
  const examType = usePlayerStore(s => s.exam) || 'doctor1'
  const { totalPass: TOTAL_PASS, isWeighted } = getExamConfig(examType)
  const pct = Math.round((correct / total) * 100)
  const mm = Math.floor(timeUsed / 60)
  const ss = timeUsed % 60
  const paperScore = isWeighted && paperConfig ? calcPaperScore(correct, total, paperConfig) : correct
  const scoreDisplay = isWeighted ? (paperScore % 1 === 0 ? paperScore : paperScore.toFixed(1)) : correct

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      <div className="px-4 pt-14 pb-6 grad-header">
        <h1 className="text-white font-bold text-2xl text-center">{paperName} 完成！</h1>
        <p className="text-white/50 text-sm text-center mt-1">{completedCount}/{totalPapers} 卷</p>
      </div>
      <div className="flex-1 px-5 py-6 flex flex-col items-center gap-5">
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100 w-full text-center">
          {isWeighted ? (
            <p className="text-4xl font-black text-medical-dark">{scoreDisplay}<span className="text-lg text-gray-400">/100 分</span></p>
          ) : (
            <p className="text-4xl font-black text-medical-dark">{correct}<span className="text-lg text-gray-400">/{total}</span></p>
          )}
          <p className="text-gray-500 text-sm mt-1">正確率 {pct}% · 用時 {mm}:{String(ss).padStart(2, '0')}</p>
        </div>

        <div className="bg-amber-50 rounded-2xl p-4 border border-amber-200 w-full">
          <p className="text-amber-800 font-bold text-sm mb-1">📋 真實國考是全卷合計算分</p>
          <p className="text-amber-700 text-xs leading-relaxed">
            總分需達 {TOTAL_PASS} 分（60%）才算及格。<br />
            繼續考完剩餘 {totalPapers - completedCount} 卷才能得到完整模擬成績。
          </p>
        </div>

        <button onClick={onContinue}
          className="w-full py-5 rounded-2xl font-bold text-xl text-white shadow-lg active:scale-95 transition-transform grad-cta">
          📝 繼續考 {nextPaperName}
        </button>
        <button onClick={onFinishSingle}
          className="w-full py-4 rounded-2xl font-bold text-lg bg-white text-gray-500 border border-gray-200 active:scale-95 transition-transform">
          先看目前的結果
        </button>
      </div>
    </div>
  )
}

// ── Results screen ───────────────────────────────────────────────
function ExamResults({ papers, navigate }) {
  const { addCoins, addExp } = usePlayerStore()
  const examType = usePlayerStore(s => s.exam) || 'doctor1'
  const { papers: PAPERS, totalPass: TOTAL_PASS, totalPoints: TOTAL_POINTS, isWeighted } = getExamConfig(examType)
  const [saved, setSaved] = useState(false)

  const isFullExam = papers.length >= PAPERS.length
  const totalCorrect = papers.reduce((s, p) => s + p.correct, 0)
  const totalQuestions = papers.reduce((s, p) => s + p.total, 0)
  const totalTime = papers.reduce((s, p) => s + p.timeUsed, 0)
  const totalScore = isWeighted ? calcTotalScore(papers, PAPERS) : totalCorrect
  const hasZeroPaper = isFullExam && papers.some(p => p.correct === 0)
  const passed = isFullExam ? (totalScore >= TOTAL_PASS && !hasZeroPaper) : null
  const pct = Math.round((totalCorrect / totalQuestions) * 100)
  const mm = Math.floor(totalTime / 60)
  const ss = totalTime % 60

  const allQuestions = papers.flatMap(p => p.questions)
  const allAnswers = papers.reduce((acc, p, pi) => {
    p.questions.forEach((_, qi) => { acc[acc._offset + qi] = p.answers[qi] })
    acc._offset += p.questions.length
    return acc
  }, { _offset: 0 })

  useEffect(() => {
    if (saved) return
    setSaved(true)
    const singlePassed = !isFullExam && pct >= 60
    const coinReward = passed === true
      ? Math.round(totalQuestions * 1.5)   // 完整模考通過：題數×1.5
      : isFullExam ? 0                     // 完整模考未過：不給獎勵
      : singlePassed ? totalQuestions      // 單科通過：題數×1
      : 0                                 // 單科未過：不給獎勵
    if (coinReward > 0) addCoins(coinReward)
    addExp(passed === true ? 150 : isFullExam ? 40 : 60)
    try {
      const key = 'mock-exam-history'
      const prev = JSON.parse(localStorage.getItem(key) || '[]')
      const paperName = isFullExam ? '完整模擬考' : papers[0].paperName
      prev.unshift({ date: new Date().toISOString(), paper: paperName, score: isWeighted ? totalScore : totalCorrect, total: isWeighted ? TOTAL_POINTS : totalQuestions, pct, passed, timeUsed: totalTime })
      localStorage.setItem(key, JSON.stringify(prev.slice(0, 20)))
    } catch {}
    // Submit per-question stats
    const stats = allQuestions.filter(q => q.id).map((q, i) => {
      const pIdx = i < (papers[0]?.questions.length || 0) ? 0 : 1
      const qIdx = pIdx === 0 ? i : i - papers[0].questions.length
      return { questionId: q.id, correct: isAnswerCorrect(papers[pIdx]?.answers[qIdx], q.answer) }
    })
    if (stats.length > 0) {
      fetch(`${BACKEND}/questions/track`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stats }),
      }).catch(() => {})
    }
  }, [])

  const wrongQuestions = allQuestions.map((q, i) => {
    const pIdx = i < (papers[0]?.questions.length || 0) ? 0 : 1
    const qIdx = pIdx === 0 ? i : i - papers[0].questions.length
    const myAnswer = papers[pIdx]?.answers[qIdx] || null
    return { ...q, myAnswer, correct: isAnswerCorrect(myAnswer, q.answer) }
  }).filter(q => !q.correct)

  return (
    <div className="flex flex-col min-h-dvh grad-header">
      <div className="flex-1 flex flex-col items-center justify-center px-5 gap-5 pt-16">
        <div className={`w-36 h-36 rounded-full border-4 flex flex-col items-center justify-center shadow-2xl bg-white/10
          ${passed === true ? 'border-green-400' : passed === false ? 'border-red-400' : 'border-white/40'}`}>
          {isWeighted ? (
            <>
              <span className="text-4xl font-black text-white">{totalScore % 1 === 0 ? totalScore : totalScore.toFixed(1)}</span>
              <span className="text-white/60 text-xs">/ {TOTAL_POINTS} 分</span>
            </>
          ) : (
            <>
              <span className="text-5xl font-black text-white">{totalCorrect}</span>
              <span className="text-white/60 text-xs">/ {totalQuestions}</span>
            </>
          )}
        </div>

        <div className="text-center">
          <h1 className="text-3xl font-bold text-white mb-1">
            {passed === true ? '🎉 及格！' : passed === false ? '😤 再接再厲' : '📊 測驗完成'}
          </h1>
          <p className="text-white/60 text-sm">{isFullExam ? '完整模擬考' : papers[0].paperName}</p>
          {!isFullExam && <p className="text-white/40 text-xs mt-1">單卷測驗不計及格，需全卷合計</p>}
          {hasZeroPaper && <p className="text-red-300 text-xs mt-1 font-bold">⚠️ 有科目零分，依規定不予錄取</p>}
        </div>

        {/* Per-paper breakdown */}
        {isFullExam && (
          <div className="flex gap-3 w-full max-w-xs">
            {papers.map((p, i) => {
              const paperScore = isWeighted ? calcPaperScore(p.correct, p.total, PAPERS[i]) : p.correct
              return (
              <div key={i} className="flex-1 bg-white/10 rounded-xl px-3 py-2 text-center">
                <p className="text-white/50 text-xs">{p.paperName}</p>
                {isWeighted ? (
                  <p className="text-white font-bold text-lg">{paperScore % 1 === 0 ? paperScore : paperScore.toFixed(1)}<span className="text-white/40 text-xs">/100</span></p>
                ) : (
                  <p className="text-white font-bold text-lg">{p.correct}/{p.total}</p>
                )}
              </div>
            )})}
          </div>
        )}

        <div className="flex gap-4">
          <div className="bg-white/10 rounded-xl px-4 py-2 text-center">
            <p className="text-white/50 text-xs">正確率</p>
            <p className="text-white font-bold text-lg">{pct}%</p>
          </div>
          <div className="bg-white/10 rounded-xl px-4 py-2 text-center">
            <p className="text-white/50 text-xs">用時</p>
            <p className="text-white font-bold text-lg">{mm}:{String(ss).padStart(2, '0')}</p>
          </div>
          {isFullExam && (
            <div className="bg-white/10 rounded-xl px-4 py-2 text-center">
              <p className="text-white/50 text-xs">及格線</p>
              <p className="text-white font-bold text-lg">{TOTAL_PASS}{isWeighted ? '分' : ''}</p>
            </div>
          )}
        </div>
      </div>

      <div className="bg-white rounded-t-3xl px-5 pt-5 pb-10 flex flex-col gap-3">
        {wrongQuestions.length > 0 && (
          <button onClick={() => navigate('/review', { state: { questions: wrongQuestions, stage: isFullExam ? '完整模擬考' : papers[0].paperName } })}
            className="w-full py-4 rounded-2xl font-bold text-lg border-2 active:scale-95 transition-transform flex items-center justify-center gap-2"
            style={{ borderColor: '#EF4444', color: '#EF4444', background: '#FFF5F5' }}>
            📋 錯題檢討（{wrongQuestions.length} 題）
          </button>
        )}
        <button onClick={() => navigate('/mock-exam')}
          className="w-full py-4 rounded-2xl font-bold text-lg text-white active:scale-95 transition-transform grad-cta">
          🔄 再考一次
        </button>
        <button onClick={() => navigate('/')}
          className="w-full py-4 rounded-2xl font-bold text-lg bg-medical-ice text-medical-dark border border-gray-200 active:scale-95 transition-transform">
          🏠 回主畫面
        </button>
        <SmartBanner />
      </div>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────
export default function MockExam() {
  const navigate = useNavigate()
  const examType = usePlayerStore(s => s.exam) || 'doctor1'
  const { papers: PAPERS, totalPass: TOTAL_PASS } = getExamConfig(examType)

  // phases: setup | loading | exam | intermission | results
  const [phase, setPhase] = useState('setup')
  const [currentPaper, setCurrentPaper] = useState(null)
  const [currentPaperIdx, setCurrentPaperIdx] = useState(0)
  const [questions, setQuestions] = useState([])
  const [paperResults, setPaperResults] = useState([])
  const [isFullExam, setIsFullExam] = useState(false)
  const startTime = useRef(0)

  const [historicalExam, setHistoricalExam] = useState(null)

  const loadQuestions = async (paper) => {
    const et = usePlayerStore.getState().exam || 'doctor1'
    const subj = paper.subject || paper.name
    const params = `count=${paper.count || 80}&subject=${encodeURIComponent(subj)}&exam=${et}`
    const res = await fetch(`${BACKEND}/questions/exam?${params}`)
    const data = await res.json()
    if (data.questions.length < 10) throw new Error('not enough')
    return data.questions
  }

  const loadHistoricalQuestions = async (year, session, subjectName) => {
    const et = usePlayerStore.getState().exam || 'doctor1'
    const res = await fetch(`${BACKEND}/questions/exam?year=${year}&session=${encodeURIComponent(session)}&subject=${encodeURIComponent(subjectName)}&exam=${et}`)
    const data = await res.json()
    if (data.questions.length < 10) throw new Error('not enough')
    return data.questions
  }

  const { coins, spendCoins } = usePlayerStore()

  const startPaper = async (paper, paperIdx, opts = {}) => {
    setCurrentPaper(paper)
    setCurrentPaperIdx(paperIdx)
    setPhase('loading')
    try {
      const qs = opts.historical
        ? await loadHistoricalQuestions(opts.historical.year, opts.historical.session, paper.subject || paper.name)
        : await loadQuestions(paper)
      setQuestions(qs)
      startTime.current = Date.now()
      setPhase('exam')
    } catch {
      alert('題目不足或載入失敗，請稍後再試')
      if (opts.refund) usePlayerStore.getState().addCoins(opts.refund)
      setPhase(paperIdx === 0 ? 'setup' : 'results')
    }
  }

  const FULL_EXAM_FEE = getFullExamFee(PAPERS)

  // Start single paper (random)
  const handleStartSingle = async (paper) => {
    const fee = getSingleExamFee(paper)
    if (!spendCoins(fee)) {
      if (confirm(`金幣不足！需要 ${fee} 金幣，目前只有 ${coins} 金幣\n\n要去看廣告賺金幣嗎？`)) navigate('/?reward=1')
      return
    }
    setIsFullExam(false)
    setHistoricalExam(null)
    setPaperResults([])
    await startPaper(paper, 0, { refund: fee })
  }

  // Start full exam (all papers sequentially)
  const handleStartFull = async () => {
    if (!spendCoins(FULL_EXAM_FEE)) {
      if (confirm(`金幣不足！需要 ${FULL_EXAM_FEE} 金幣，目前只有 ${coins} 金幣\n\n要去看廣告賺金幣嗎？`)) navigate('/?reward=1')
      return
    }
    setIsFullExam(true)
    setHistoricalExam(null)
    setPaperResults([])
    await startPaper(PAPERS[0], 0, { refund: FULL_EXAM_FEE })
  }

  // Start historical exam
  const handleStartHistorical = async (year, session, isFull, paper) => {
    const targetPaper = paper || PAPERS[0]
    const fee = isFull ? FULL_EXAM_FEE : getSingleExamFee(targetPaper)
    if (!spendCoins(fee)) {
      if (confirm(`金幣不足！需要 ${fee} 金幣，目前只有 ${coins} 金幣\n\n要去看廣告賺金幣嗎？`)) navigate('/?reward=1')
      return
    }
    setIsFullExam(isFull)
    setHistoricalExam({ year, session })
    setPaperResults([])
    await startPaper(targetPaper, 0, { historical: { year, session }, refund: fee })
  }

  const handleFinishPaper = (answers) => {
    const timeUsed = Math.floor((Date.now() - startTime.current) / 1000)
    const correct = questions.filter((q, i) => isAnswerCorrect(answers[i], q.answer)).length
    const result = {
      paperName: currentPaper.name,
      questions: [...questions],
      answers: { ...answers },
      correct,
      total: questions.length,
      timeUsed,
    }

    // Record per-subject accuracy
    const examType = usePlayerStore.getState().exam || 'doctor1'
    const batchResults = questions.map((q, i) => ({
      tag: q.subject_tag || q.subject_name,
      isCorrect: isAnswerCorrect(answers[i], q.answer),
    }))
    useAccuracyStore.getState().recordBatch(examType, batchResults)

    const newResults = [...paperResults, result]
    setPaperResults(newResults)

    if (isFullExam && newResults.length < PAPERS.length) {
      // More papers to go → show intermission
      setPhase('intermission')
    } else {
      setPhase('results')
    }
  }

  // Continue to next paper
  const handleContinueNext = async () => {
    const nextIdx = paperResults.length
    const nextPaper = PAPERS[nextIdx]
    await startPaper(nextPaper, nextIdx, historicalExam ? { historical: historicalExam } : {})
  }

  // View current results only (stop early)
  const handleFinishSingle = () => {
    setIsFullExam(false)
    setPhase('results')
  }

  if (phase === 'setup') {
    return <ExamSetup onStart={handleStartSingle} onStartFull={handleStartFull} onStartHistorical={handleStartHistorical} onBack={() => navigate('/')} coins={coins} />
  }

  if (phase === 'loading' || phase === 'loading2') {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh bg-medical-ice gap-4">
        <div className="text-5xl animate-bounce">📝</div>
        <p className="text-gray-500 font-medium">
          {currentPaper ? `正在載入 ${currentPaper.name}…` : historicalExam ? `正在載入 ${historicalExam.year}年${historicalExam.session}…` : '正在出題中…'}
        </p>
      </div>
    )
  }

  if (phase === 'exam') {
    return <ExamInProgress paper={currentPaper} questions={questions} onFinish={handleFinishPaper} onBack={() => setPhase('setup')} />
  }

  if (phase === 'intermission') {
    const nextIdx = paperResults.length
    const nextPaper = PAPERS[nextIdx]
    return (
      <Intermission
        paper1Result={paperResults[paperResults.length - 1]}
        onContinue={handleContinueNext}
        onFinishSingle={handleFinishSingle}
        nextPaperName={nextPaper?.name || '下一卷'}
        completedCount={paperResults.length}
        totalPapers={PAPERS.length}
        paperConfig={PAPERS[paperResults.length - 1]}
      />
    )
  }

  // results
  return <ExamResults papers={paperResults} navigate={navigate} />
}
