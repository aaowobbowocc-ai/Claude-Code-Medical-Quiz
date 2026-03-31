import React from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/gameStore'

const STAGES = [
  { id: 0,  name: '隨機混合',    icon: '🎲', color: 'bg-gray-500',           count: 1238 },
  { id: 1,  name: '解剖學殿堂',  icon: '🦴', color: 'bg-blue-500',           count: 306 },
  { id: 2,  name: '生理學之谷',  icon: '💓', color: 'bg-red-500',            count: 114 },
  { id: 3,  name: '生化迷宮',    icon: '⚗️', color: 'bg-purple-500',         count: 208 },
  { id: 4,  name: '組織胚胎學',  icon: '🔬', color: 'bg-indigo-500',         count: 65 },
  { id: 5,  name: '微免聖域',    icon: '🦠', color: 'bg-green-500',          count: 195 },
  { id: 6,  name: '寄生蟲荒原',  icon: '🪱', color: 'bg-yellow-600',         count: 27 },
  { id: 7,  name: '藥理決鬥場',  icon: '💊', color: 'bg-orange-500',         count: 193 },
  { id: 8,  name: '病理學深淵',  icon: '🩺', color: 'bg-rose-600',           count: 97 },
  { id: 9,  name: '公衛學巔峰',  icon: '📊', color: 'bg-teal-600',           count: 33 },
]

export default function Map() {
  const navigate = useNavigate()
  const { unlockedStages, level } = usePlayerStore()

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      {/* Header */}
      <div className="bg-medical-blue px-5 pt-12 pb-6 text-white">
        <button onClick={() => navigate('/')} className="text-sm opacity-70 mb-2">← 返回</button>
        <h1 className="text-2xl font-bold">關卡地圖</h1>
        <p className="text-sm opacity-70 mt-1">選擇科目，挑戰對手</p>
      </div>

      {/* Stages grid */}
      <div className="flex-1 px-4 py-5 grid grid-cols-2 gap-3">
        {STAGES.map((stage) => {
          const locked = !unlockedStages.includes(stage.id)
          return (
            <div
              key={stage.id}
              className={`rounded-2xl p-4 flex flex-col gap-2 shadow-sm transition-all
                ${locked ? 'opacity-50 bg-gray-200' : 'bg-white active:scale-95 cursor-pointer'}`}
              onClick={() => !locked && navigate('/', { state: { stage: stage.id } })}
            >
              <div className={`w-12 h-12 rounded-xl ${stage.color} flex items-center justify-center text-2xl`}>
                {locked ? '🔒' : stage.icon}
              </div>
              <p className="font-bold text-medical-dark text-sm leading-tight">{stage.name}</p>
              <p className="text-xs text-gray-400">{stage.count} 題</p>
              {locked && (
                <p className="text-xs text-gray-400">Lv.{stage.id * 2} 解鎖</p>
              )}
            </div>
          )
        })}
      </div>

      <p className="text-center text-xs text-gray-400 pb-5">
        目前等級 Lv.{level} · 繼續對戰解鎖更多關卡
      </p>
    </div>
  )
}
