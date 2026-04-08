import { Link } from 'react-router-dom'
import { usePlayerStore, EXAM_TYPES } from '../store/gameStore'

const EXAM_PLATFORM_NAME = {
  doctor1: '醫學知識王 — 醫師國考一階題庫練習平台',
  doctor2: '醫學知識王 — 醫師國考二階題庫練習平台',
  dental1: '牙醫知識王 — 牙醫國考一階題庫練習平台',
  dental2: '牙醫知識王 — 牙醫國考二階題庫練習平台',
  pharma1: '藥學知識王 — 藥師國考一階題庫練習平台',
  pharma2: '藥學知識王 — 藥師國考二階題庫練習平台',
}

export default function Footer() {
  const exam = usePlayerStore(s => s.exam) || 'doctor1'
  const platformName = EXAM_PLATFORM_NAME[exam] || EXAM_PLATFORM_NAME.doctor1
  return (
    <footer className="bg-white border-t border-gray-100 px-5 py-5 text-center text-xs text-gray-400 space-y-2.5">
      <div className="flex items-center justify-center gap-3 flex-wrap">
        <Link to="/privacy" className="hover:text-medical-blue transition-colors">隱私權政策</Link>
        <span className="text-gray-200">|</span>
        <Link to="/tos" className="hover:text-medical-blue transition-colors">服務條款</Link>
        <span className="text-gray-200">|</span>
        <Link to="/contact" className="hover:text-medical-blue transition-colors">關於我們</Link>
      </div>
      <p>© {new Date().getFullYear()} {platformName}</p>
      <p className="text-gray-300">題目來源：考選部歷年公開試題 · AI 解說僅供參考</p>
      <p className="text-gray-300">aaowobbowocc@gmail.com</p>
    </footer>
  )
}
