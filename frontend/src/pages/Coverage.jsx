import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import Footer from '../components/Footer'

const API = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

const EXAM_ORDER = [
  'doctor1', 'doctor2', 'dental1', 'dental2',
  'pharma1', 'pharma2', 'tcm1', 'tcm2',
  'nursing', 'nutrition', 'medlab', 'pt', 'ot', 'radiology',
  'social-worker', 'vet',
  'lawyer1', 'judicial', 'customs', 'police',
  'civil-senior', 'civil-senior-general', 'civil-junior-general', 'civil-elementary-general',
  'driver-car', 'driver-moto',
]

const ALL_YEARS = ['100','101','102','103','104','105','106','107','108','109','110','111','112','113','114','115']

// Exams where questions have no roc_year (non-annual question banks)
const NON_YEAR_KEYS = new Set(['undefined', 'null', ''])
function isNonAnnual(examInfo) {
  const years = Object.keys(examInfo.years)
  return years.length === 0 || years.every(y => NON_YEAR_KEYS.has(y))
}

function getTotalCount(examInfo) {
  let total = 0
  for (const yd of Object.values(examInfo.years)) {
    for (const count of Object.values(yd)) total += count
  }
  return total
}

function CoverageRow({ examId, info }) {
  const [expanded, setExpanded] = useState(false)
  const yearData = info.years || {}

  // Non-annual exams (driver license etc.)
  if (isNonAnnual(info)) {
    const total = getTotalCount(info)
    return (
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 px-4 py-3 flex items-center gap-3">
        <span className="text-lg">{info.icon}</span>
        <div>
          <p className="font-bold text-sm text-gray-800">{info.name}</p>
          <p className="text-xs text-gray-400">共 {total.toLocaleString()} 題（非年度制）</p>
        </div>
      </div>
    )
  }

  // Compute per-year session counts
  const yearTotals = {}
  for (const yr of ALL_YEARS) {
    const yd = yearData[yr] || {}
    yearTotals[yr] = { s1: yd['第一次'] || 0, s2: yd['第二次'] || 0 }
  }

  // Determine if this exam runs twice/year (has any second sessions)
  const hasSecondSessions = ALL_YEARS.some(yr => yearTotals[yr].s2 > 0)

  // For 2-session exams: first year where second session data exists
  const firstSecondSessionYear = hasSecondSessions
    ? ALL_YEARS.find(yr => yearTotals[yr].s2 > 0)
    : null

  // Collect years that actually have any questions
  const activeYears = ALL_YEARS.filter(yr => yearTotals[yr].s1 > 0 || yearTotals[yr].s2 > 0)

  const firstActiveYear = activeYears[0]
  const lastActiveYear = activeYears[activeYears.length - 1]

  let grandTotal = 0
  let missingCount = 0
  for (const yr of ALL_YEARS) {
    const { s1, s2 } = yearTotals[yr]
    grandTotal += s1 + s2
    if (!firstActiveYear || yr < firstActiveYear || yr > lastActiveYear) continue
    // Missing first session within active range
    if (s1 === 0) missingCount++
    // Missing second session for exams that run twice
    else if (hasSecondSessions && s2 === 0 && firstSecondSessionYear && yr >= firstSecondSessionYear) missingCount++
  }

  const displayYears = activeYears.length > 0 ? activeYears : ALL_YEARS.slice(0, 3)

  function getCell(yr, sess) {
    const count = sess === 's1' ? yearTotals[yr].s1 : yearTotals[yr].s2
    const hasFirst = yearTotals[yr].s1 > 0
    const hasSecond = yearTotals[yr].s2 > 0
    const hasAny = hasFirst || hasSecond

    if (sess === 's2') {
      if (!hasSecondSessions) return null // don't render second row at all

      // Before second sessions started: show nothing
      if (firstSecondSessionYear && yr < firstSecondSessionYear) {
        return { type: 'none' }
      }
      // Year has no data at all: gray dot
      if (!hasAny) return { type: 'empty' }
      // Has first but no second: missing
      if (hasFirst && !hasSecond) return { type: 'missing' }
      // Has second data
      return { type: 'ok', count }
    } else {
      // First session
      if (!hasAny) return { type: 'empty' }
      if (count === 0) return { type: 'missing' }
      return { type: 'ok', count }
    }
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-4 py-3 active:bg-gray-50"
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">{info.icon}</span>
          <div className="text-left">
            <p className="font-bold text-sm text-gray-800">{info.name}</p>
            <p className="text-xs text-gray-400">
              {grandTotal.toLocaleString()} 題
              {missingCount > 0 && <span className="text-red-400"> · 缺 {missingCount} 場</span>}
            </p>
          </div>
        </div>
        <span className="text-gray-400 text-sm">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 overflow-x-auto">
          <table className="text-[11px] w-full" style={{ minWidth: Math.max(400, displayYears.length * 38) + 40 }}>
            <thead>
              <tr>
                <th className="text-left text-gray-400 font-normal pb-1 pr-1 w-6"></th>
                {displayYears.map(yr => (
                  <th key={yr} className="text-center text-gray-400 font-normal pb-1 px-0.5 w-9">{yr}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {['s1', 's2'].map(sess => {
                if (sess === 's2' && !hasSecondSessions) return null
                return (
                  <tr key={sess}>
                    <td className="text-gray-400 pr-1 py-0.5 text-[10px]">{sess === 's1' ? '一' : '二'}</td>
                    {displayYears.map(yr => {
                      const cell = getCell(yr, sess)
                      if (!cell) return null
                      return (
                        <td key={yr} className="px-0.5 py-0.5 text-center">
                          {cell.type === 'none' && <span className="text-gray-200 text-[10px]">·</span>}
                          {cell.type === 'empty' && <span className="text-gray-200 text-[10px]">·</span>}
                          {cell.type === 'missing' && (
                            <span title={`${yr} ${sess === 's1' ? '第一次' : '第二次'}: 無資料`}
                                  className="inline-block rounded px-1 py-0.5 font-mono text-[10px] min-w-[28px] bg-red-100 text-red-400">
                              ✗
                            </span>
                          )}
                          {cell.type === 'ok' && (
                            <span title={`${yr} ${sess === 's1' ? '第一次' : '第二次'}: ${cell.count} 題`}
                                  className={`inline-block rounded px-1 py-0.5 font-mono text-[10px] min-w-[28px] ${
                                    cell.count < 100 ? 'bg-amber-100 text-amber-600' : 'bg-emerald-100 text-emerald-700'
                                  }`}>
                              {cell.count}
                            </span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>

          {missingCount > 0 && (
            <p className="text-xs text-red-500 mt-2">
              ✗ = 該場次範圍內無題目，可能待補
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export default function Coverage() {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetch(`${API}/questions/coverage`)
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json() })
      .then(d => { setData(d); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [])

  const orderedExams = data
    ? [
        ...EXAM_ORDER.filter(id => data[id]),
        ...Object.keys(data).filter(id => !EXAM_ORDER.includes(id)).sort(),
      ]
    : []

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      <div className="grad-header px-5 pt-14 pb-6">
        <button onClick={() => navigate(-1)}
                className="absolute top-4 left-3 text-white/70 text-sm flex items-center gap-1 active:scale-95">
          ← 返回
        </button>
        <h1 className="text-white font-bold text-2xl text-center">📊 題庫覆蓋率</h1>
        <p className="text-white/50 text-sm text-center mt-1">各考試年度 × 場次題數</p>
      </div>

      <div className="flex-1 px-4 py-5 space-y-3">
        <div className="flex items-center gap-3 text-xs text-gray-500 px-1 flex-wrap">
          <span className="flex items-center gap-1">
            <span className="inline-block w-6 h-4 rounded bg-emerald-100"></span> 有題
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-6 h-4 rounded bg-amber-100"></span> &lt;100（殘缺）
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-6 h-4 rounded bg-red-100 text-red-400 text-center text-[10px] leading-4">✗</span> 缺題
          </span>
          <span className="flex items-center gap-1">
            <span className="text-gray-300">·</span> 未舉辦 / 不適用
          </span>
        </div>

        {loading && (
          <div className="text-center text-gray-400 py-12">
            <div className="flex gap-1.5 justify-center py-2">
              {[0,1,2].map(i => (
                <span key={i} className="w-2 h-2 rounded-full bg-gray-300 animate-bounce"
                      style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="text-center text-red-400 py-8">
            <p className="text-2xl mb-2">⚠️</p>
            <p className="text-sm">載入失敗：{error}</p>
          </div>
        )}

        {data && orderedExams.map(examId => (
          <CoverageRow key={examId} examId={examId} info={data[examId]} />
        ))}
      </div>

      <Footer />
    </div>
  )
}
