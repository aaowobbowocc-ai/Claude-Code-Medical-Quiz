import { useParams, Link, Navigate } from 'react-router-dom'
import guidesData from '../guides.json'
import { usePageMeta } from '../hooks/usePageMeta'

export default function GuideDetail() {
  const { slug } = useParams()
  const guide = guidesData.guides.find(g => g.slug === slug)
  usePageMeta(
    guide ? `${guide.title}｜國考知識王` : '備考攻略',
    guide ? guide.description : ''
  )
  if (!guide) return <Navigate to="/guides" />
  return (
    <article className="max-w-3xl mx-auto px-4 py-6">
      <nav className="text-xs text-gray-400 mb-3">
        <Link to="/guides" className="hover:text-medical-blue">備考攻略</Link>
        <span className="mx-2">›</span>
        <span>{guide.title}</span>
      </nav>
      <h1 className="text-2xl font-bold text-medical-dark mb-2">{guide.title}</h1>
      <p className="text-xs text-gray-400 mb-6">{guide.date}</p>
      <div
        className="prose prose-sm max-w-none text-gray-800 leading-relaxed [&_h2]:text-lg [&_h2]:font-bold [&_h2]:text-medical-dark [&_h2]:mt-6 [&_h2]:mb-3 [&_ol]:list-decimal [&_ol]:ml-6 [&_ul]:list-disc [&_ul]:ml-6 [&_p]:my-3 [&_code]:bg-gray-100 [&_code]:px-1 [&_code]:rounded"
        dangerouslySetInnerHTML={{ __html: guide.contentHtml }}
      />
      {guide.related && guide.related.length > 0 && (
        <div className="mt-8 pt-6 border-t border-gray-100">
          <h3 className="text-sm font-bold text-gray-500 mb-3">相關資源</h3>
          <div className="space-y-2">
            {guide.related.map(r => (
              <Link key={r.slug} to={r.slug} className="block text-medical-blue hover:underline text-sm">
                → {r.label}
              </Link>
            ))}
          </div>
        </div>
      )}
      <div className="mt-10 text-center">
        <Link to="/guides" className="text-gray-400 text-sm hover:text-medical-blue">← 返回攻略列表</Link>
      </div>
    </article>
  )
}
