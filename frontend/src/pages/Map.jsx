import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/gameStore'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

const STAGE_ICONS = {
  all: '🎲', anatomy: '🦴', physiology: '💓', biochemistry: '⚗️', histology: '🔬',
  embryology: '🧬', microbiology: '🦠', parasitology: '🪱', pharmacology: '💊',
  pathology: '🩺', public_health: '📊',
  internal_medicine: '🫀', infectious_disease: '🦠', hematology: '🩸', psychiatry: '🧠',
  dermatology: '🧴', pediatrics: '👶', neurology: '🧬', surgery: '🔪',
  orthopedics: '🦴', urology: '🫘', anesthesia: '😴', ophthalmology: '👁️',
  ent: '👂', obstetrics_gynecology: '🤰', rehabilitation: '🏋️', emergency: '🚑',
  medical_law_ethics: '⚖️',
  dental_anatomy: '🦷', tooth_morphology: '🦷', embryology_histology: '🔬',
  oral_pathology: '🩺', dental_pharmacology: '💊', dental_microbiology: '🦠', oral_physiology: '💓',
  oral_surgery: '🔪', periodontics: '🦷', orthodontics: '😁', pediatric_dentistry: '👶',
  endodontics: '🦷', operative_dentistry: '🪥', dental_materials: '🧪',
  fixed_prosthodontics: '👑', removable_prosthodontics: '🫦', oral_diagnosis: '🔍',
  dental_radiology: '📷', dental_public_health: '📊', dental_ethics_law: '⚖️',
  medicinal_chemistry: '⚗️', pharmaceutical_analysis: '📊', pharmacognosy: '🌿',
  pharmaceutics: '💊', biopharmaceutics: '🧬',
  dispensing: '🏥', clinical_pharmacy: '💉', pharmacotherapy: '🩺', pharmacy_law: '⚖️',
}

const BG_COLORS = ['bg-gray-500', 'bg-blue-500', 'bg-red-500', 'bg-purple-500', 'bg-indigo-500', 'bg-green-500', 'bg-yellow-600', 'bg-orange-500', 'bg-rose-600', 'bg-teal-600', 'bg-indigo-400', 'bg-pink-500', 'bg-cyan-600', 'bg-amber-600', 'bg-emerald-500', 'bg-violet-500', 'bg-sky-500', 'bg-lime-600']

export default function Map() {
  const navigate = useNavigate()
  const { unlockedStages, level, exam } = usePlayerStore()
  const [STAGES, setSTAGES] = useState([])

  useEffect(() => {
    fetch(`${BACKEND}/meta?exam=${exam || 'doctor1'}`)
      .then(r => r.json())
      .then(data => {
        if (data.stages) {
          setSTAGES(data.stages.map((s, i) => ({
            id: s.id,
            name: s.name,
            icon: STAGE_ICONS[s.tag] || '📝',
            color: BG_COLORS[i % BG_COLORS.length],
            count: s.count,
          })))
        }
      })
      .catch(() => {})
  }, [exam])

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
