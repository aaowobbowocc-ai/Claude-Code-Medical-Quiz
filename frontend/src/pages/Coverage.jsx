import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import Footer from '../components/Footer'

const API = import.meta.env.VITE_API_URL || 'https://backend-6v6i.onrender.com'

// Expected sessions per year for each exam group
// Exams that run twice/year have both sessions; single-session exams only have one
const EXAM_ORDER = [
  'doctor1', 'doctor2', 'dental1', 'dental2',
  'pharma1', 'pharma2', 'tcm1', 'tcm2',
  'nursing', 'nutrition', 'medlab', 'pt', 'ot', 'radiology',
  'social-worker',
]

const ALL_YEARS = ['100','101','102','103','104','105','106','107','108','109','110','111','112','113','114','115']

function getCellColor(count, hasAny) {
  if (!hasAny) return 'bg-gray-100 text-gray-300'
  if (count === 0) return 'bg-red-100 text-red-400'
  if (count < 100) return 'bg-amber-100 text-amber-600'
  return 'bg-emerald-100 text-emerald-700'
}

function CoverageRow({ examId, info }) {
  const [expanded, setExpanded] = useState(false)
  const yearData = info.years || {}

  const sessionTotals = {}
  let grandTotal = 0
  for (const yr of ALL_YEARS) {
    const yd = yearData[yr] || {}
    const s1 = yd['第一次'] || 0
    const s2 = yd['第二次'] || 0
    sessionTotals[yr] = { s1, s2 }
    grandTotal += s1 + s2
  }

  const missingYears = ALL_YEARS.filter(yr => {
    const { s1, s2 } = sessionTotals[yr]
    return s1 === 0 && s2 === 0
  })

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
            <p className="text-xs text-gray-400">{grandTotal.toLocaleString()} 題 · 缺 {missingYears.length} 年</p>
          </div>
        </div>
        <span className="text-gray-400 text-sm">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 overflow-x-auto">
          <table className="text-xs w-full min-w-[640px]">
            <thead>
              <tr>
                <th className="text-left text-gray-400 font-normal pb-1 pr-2 w-12">場次</th>
                {ALL_YEARS.map(yr => (
                  <th key={yr} className="text-center text-gray-400 font-normal pb-1 px-0.5">{yr}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {['第一次', '第二次'].map(sess => {
                const sessKey = sess === '第一次' ? 's1' : 's2'
                return (
                  <tr key={sess}>
                    <td className="text-gray-500 pr-2 py-1 whitespace-nowrap">{sess === '第一次' ? '一' : '二'}</td>
                    {ALL_YEARS.map(yr => {
                      const count = sessionTotals[yr][sessKey]
                      const hasAny = (yearData[yr]?.['第一次'] || 0) > 0 || (yearData[yr]?.['第二次'] || 0) > 0
                      // Detect if this exam is single-session only in this year
                      const otherCount = sess === '第一次' ? sessionTotals[yr].s2 : sessionTotals[yr].s1
                      const isSingleSession = count === 0 && otherCount === 0 && hasAny === false
                      const isOnlySingleSess = count === 0 && otherCount > 0
                      return (
                        <td key={yr} className="px-0.5 py-1 text-center">
                          {isOnlySingleSess ? (
                            <span className="text-gray-200 text-[10px]">—</span>
                          ) : (
                            <span
                              title={count > 0 ? `${yr} ${sess}: ${count} 題` : `${yr} ${sess}: 無資料`}
                              className={`inline-block rounded px-1 py-0.5 font-mono text-[10px] min-w-[28px] ${getCellColor(count, !isSingleSession)}`}
                            >
                              {count > 0 ? count : '✗'}
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

          {missingYears.length > 0 && (
            <p className="text-xs text-red-500 mt-2">
              缺 {missingYears.join('、')} 年資料
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
      .then(r => r.json())
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
        <p className="text-white/50 text-sm text-center mt-1">各考試 × 年度 × 場次題數</p>
      </div>

      <div className="flex-1 px-4 py-5 space-y-3">
        {/* Legend */}
        <div className="flex items-center gap-3 text-xs text-gray-500 px-1">
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 h-4 rounded bg-emerald-100"></span> 有題目
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 h-4 rounded bg-amber-100"></span> &lt;100 題（殘缺）
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 h-4 rounded bg-red-100"></span> 缺題
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
