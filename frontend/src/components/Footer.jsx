import { Link } from 'react-router-dom'
import { usePlayerStore } from '../store/gameStore'
import { getPlatformName } from '../config/examRegistry'

export default function Footer() {
  const exam = usePlayerStore(s => s.exam) || 'doctor1'
  const platformName = getPlatformName(exam)
  return (
    <footer className="bg-white border-t border-gray-100 px-5 py-5 text-center text-xs text-gray-400 space-y-2.5">
      <div className="flex items-center justify-center gap-3 flex-wrap">
        <Link to="/privacy" className="hover:text-medical-blue transition-colors">隱私權政策</Link>
        <span className="text-gray-200">|</span>
        <Link to="/tos" className="hover:text-medical-blue transition-colors">服務條款</Link>
        <span className="text-gray-200">|</span>
        <Link to="/contact" className="hover:text-medical-blue transition-colors">關於我們</Link>
        <span className="text-gray-200">|</span>
        <Link to="/changelog" className="hover:text-medical-blue transition-colors">更新公告</Link>
        <span className="text-gray-200">|</span>
        <Link to="/coverage" className="hover:text-medical-blue transition-colors">題庫狀態</Link>
      </div>
      <p>© {new Date().getFullYear()} {platformName}</p>
      <p className="text-gray-300">題目來源：考選部歷年公開試題 · AI 解說僅供參考</p>
      <p className="text-gray-300">聯絡資訊：aaowobbowocc@gmail.com</p>
    </footer>
  )
}
