import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'

const TABS = [
  { key: 'battle', label: '⚔️ 對戰', storageKey: 'battle-history' },
  { key: 'practice', label: '🎯 練習', storageKey: 'practice-history' },
  { key: 'mock', label: '📝 模擬考', storageKey: 'mock-exam-history' },
]

function getRecords(storageKey) {
  try { return JSON.parse(localStorage.getItem(storageKey) || '[]') } catch { return [] }
}

function formatDate(iso) {
  const d = new Date(iso)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const STAGES_MAP = {
  0: '隨機混合', 1: '解剖學殿堂', 2: '生理學之谷', 3: '生化迷宮',
  4: '組織學祕境', 5: '微免聖域', 6: '寄生蟲荒原',
  7: '藥理決鬥場', 8: '病理學深淵', 9: '公衛學巔峰', 10: '胚胎學源脈',
}

const DIFF_MAP = { easy: '初級', medium: '普通', hard: '困難', expert: '地獄' }

/* ── Battle record card ─────────────────────────────────────── */
function BattleCard({ r, navigate }) {
  const isWin = r.rank === 1
  const pct = r.totalCount > 0 ? Math.round((r.correctCount / r.totalCount) * 100) : 0
  const oppStr = r.opponents?.map(o => o.name).join('、') || '—'
  const wrongCount = r.totalCount - r.correctCount

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="flex items-center gap-3 px-4 pt-3 pb-2">
        <span className="text-2xl">{isWin ? '🏆' : '💪'}</span>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-xs font-bold px-2 py-0.5 rounded-full text-white ${isWin ? 'bg-amber-400' : 'bg-gray-400'}`}>
              {isWin ? '勝利' : `第 ${r.rank} 名`}
            </span>
            <span className="text-xs text-gray-400">{r.stage}</span>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">vs {oppStr} · {formatDate(r.date)}</p>
        </div>
        <div className="text-right">
          <p className="font-bold text-medical-dark text-lg leading-tight">{r.myScore}</p>
          <p className="text-xs text-gray-400">分</p>
        </div>
      </div>
      <div className="flex items-center gap-3 px-4 pb-3 border-t border-gray-50 pt-2">
        <div className="flex-1">
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-gray-400">正確率</span>
            <span className="font-semibold text-medical-dark">{r.correctCount}/{r.totalCount} ({pct}%)</span>
          </div>
          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct >= 70 ? '#10B981' : pct >= 50 ? '#F97316' : '#EF4444' }} />
          </div>
        </div>
        {wrongCount > 0 && r.questions?.length > 0 && (
          <button onClick={() => navigate('/review', { state: { questions: r.questions, stage: r.stage } })}
            className="shrink-0 text-xs font-bold px-3 py-2 rounded-xl text-white active:scale-95 transition-transform"
            style={{ background: '#EF4444' }}>
            📋 檢討 {wrongCount} 題
          </button>
        )}
        {wrongCount === 0 && r.totalCount > 0 && (
          <span className="text-xs text-green-500 font-semibold shrink-0">全對 🎉</span>
        )}
      </div>
    </div>
  )
}

/* ── Practice record card ───────────────────────────────────── */
function PracticeCard({ r }) {
  const stageName = STAGES_MAP[r.stage] || '隨機'
  const diffName = DIFF_MAP[r.diff] || r.diff
  const pct = r.pct || 0

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden px-4 py-3">
      <div className="flex items-center gap-3 mb-2">
        <span className="text-2xl">{pct >= 70 ? '🎯' : '💪'}</span>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-600">{diffName}</span>
            <span className="text-xs text-gray-400">{stageName}</span>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">{r.count} 題 · {formatDate(r.date)}</p>
        </div>
        <div className="text-right">
          <p className="font-bold text-medical-dark text-lg leading-tight">{pct}%</p>
          <p className="text-xs text-gray-400">{r.correct}/{r.total}</p>
        </div>
      </div>
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct >= 70 ? '#10B981' : pct >= 50 ? '#F97316' : '#EF4444' }} />
      </div>
    </div>
  )
}

/* ── Mock exam record card ──────────────────────────────────── */
function MockCard({ r }) {
  const mm = Math.floor((r.timeUsed || 0) / 60)
  const ss = (r.timeUsed || 0) % 60

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden px-4 py-3">
      <div className="flex items-center gap-3 mb-2">
        <span className="text-2xl">{r.passed ? '🎉' : '😤'}</span>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-xs font-bold px-2 py-0.5 rounded-full text-white ${r.passed ? 'bg-green-500' : 'bg-red-400'}`}>
              {r.passed ? '及格' : '不及格'}
            </span>
            <span className="text-xs text-gray-400">{r.paper}</span>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">用時 {mm}:{String(ss).padStart(2, '0')} · {formatDate(r.date)}</p>
        </div>
        <div className="text-right">
          <p className="font-bold text-medical-dark text-lg leading-tight">{r.score}</p>
          <p className="text-xs text-gray-400">/ {r.total}</p>
        </div>
      </div>
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${r.pct}%`, background: r.pct >= 60 ? '#10B981' : r.pct >= 40 ? '#F97316' : '#EF4444' }} />
      </div>
    </div>
  )
}

/* ── Main page ──────────────────────────────────────────────── */
export default function History() {
  const navigate = useNavigate()
  const [tab, setTab] = useState('battle')
  const currentTab = TABS.find(t => t.key === tab)
  const records = getRecords(currentTab.storageKey)

  return (
    <div className="flex flex-col min-h-dvh no-select bg-medical-ice">
      <div className="sticky top-0 z-10 px-4 pt-12 pb-3 grad-header">
        <div className="flex items-center gap-3 mb-3">
          <button onClick={() => navigate(-1)} className="text-white/60 text-2xl leading-none">‹</button>
          <h1 className="text-white font-bold text-xl flex-1">歷史紀錄</h1>
          <span className="text-white/50 text-sm">{records.length} 筆</span>
        </div>
        <div className="flex gap-2">
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${
                tab === t.key ? 'bg-white text-medical-blue shadow' : 'bg-white/15 text-white/60'
              }`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 px-4 py-4 flex flex-col gap-3">
        {records.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <span className="text-5xl">{tab === 'battle' ? '🎮' : tab === 'practice' ? '🎯' : '📝'}</span>
            <p className="text-gray-400 text-sm">還沒有紀錄</p>
            <button onClick={() => navigate('/')}
              className="mt-2 px-6 py-3 rounded-2xl font-bold text-white text-sm active:scale-95 grad-cta">
              去挑戰
            </button>
          </div>
        )}

        {tab === 'battle' && records.map(r => <BattleCard key={r.id} r={r} navigate={navigate} />)}
        {tab === 'practice' && records.map(r => <PracticeCard key={r.id} r={r} />)}
        {tab === 'mock' && records.map(r => <MockCard key={r.date} r={r} />)}
      </div>
    </div>
  )
}
