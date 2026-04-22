import { Link } from 'react-router-dom'
import guidesData from '../guides.json'
import { usePageMeta } from '../hooks/usePageMeta'

export default function Guides() {
  usePageMeta(
    '備考攻略｜國考知識王',
    '國考備考攻略與學習心法：醫師、藥師、護理師、醫檢師等各國考準備指南，以及 AI 刷題、間隔重複等學習法實戰。'
  )
  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-medical-dark mb-2">備考攻略</h1>
      <p className="text-gray-500 text-sm mb-6">依考試類別 & 學習方法整理的長文指南。</p>
      <div className="space-y-3">
        {guidesData.guides.map(g => (
          <Link
            key={g.slug}
            to={`/guides/${g.slug}`}
            className="block p-4 rounded-2xl bg-white hover:bg-blue-50 border border-gray-100 transition-colors"
          >
            <h2 className="font-bold text-medical-dark">{g.title}</h2>
            <p className="text-sm text-gray-500 mt-1 line-clamp-2">{g.description}</p>
            <p className="text-xs text-gray-400 mt-2">{g.date}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}
