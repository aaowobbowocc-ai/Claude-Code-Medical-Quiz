import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import Footer from '../components/Footer'

/**
 * 站長雜貨間 — 讀累了沒事可以滑進來逛的地方。
 * 商品資料從 /break-lounge.json 載入，未來增加商品不用改 code。
 * 全頁強調「站長私藏」+「分潤協助平台」誠實風格，避免廣告感。
 */
export default function BreakLounge() {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [activeSection, setActiveSection] = useState('all')

  useEffect(() => {
    fetch('/break-lounge.json', { cache: 'no-cache' })
      .then(r => r.json())
      .then(setData)
      .catch(() => setData({ sections: [] }))
  }, [])

  const sections = useMemo(() => {
    if (!data) return []
    return data.sections.filter(s => activeSection === 'all' || s.id === activeSection)
  }, [data, activeSection])

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      <div className="grad-header px-5 pt-14 pb-6 relative">
        <button onClick={() => navigate(-1)}
                className="absolute top-4 left-3 text-white/70 text-sm flex items-center gap-1 active:scale-95">
          ← 返回
        </button>
        <h1 className="text-white font-bold text-2xl text-center">🛍️ 站長雜貨間</h1>
        <p className="text-white/60 text-xs text-center mt-1">隨便逛逛</p>
      </div>

      <div className="flex-1 px-4 py-5 space-y-4">
        {/* Intro card */}
        {data?.intro && (
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">{data.intro}</p>
          </div>
        )}

        {/* Section tabs */}
        {data && (
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4">
            <button
              onClick={() => setActiveSection('all')}
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap ${
                activeSection === 'all' ? 'bg-medical-blue text-white' : 'bg-white text-gray-600 border border-gray-200'
              }`}
            >全部</button>
            {data.sections.map(s => (
              <button
                key={s.id}
                onClick={() => setActiveSection(s.id)}
                className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap ${
                  activeSection === s.id ? 'bg-medical-blue text-white' : 'bg-white text-gray-600 border border-gray-200'
                }`}
              >{s.icon} {s.title.replace(/（.*$/, '')}</button>
            ))}
          </div>
        )}

        {/* Sections */}
        {sections.map(section => (
          <SectionCard key={section.id} section={section} />
        ))}

        {/* Loading state */}
        {!data && (
          <div className="text-center text-gray-400 py-12">
            <div className="flex gap-1.5 justify-center py-2">
              {[0,1,2].map(i => (
                <span key={i} className="w-2 h-2 rounded-full bg-gray-300 animate-bounce"
                      style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </div>
          </div>
        )}

        <div className="text-center text-[11px] text-gray-300 pt-4 pb-2">
          放點廣告維持生計，有興趣可以逛逛
        </div>
      </div>

      <Footer />
    </div>
  )
}

function SectionCard({ section }) {
  const hasProducts = section.products && section.products.length > 0
  return (
    <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-lg">{section.icon}</span>
        <h2 className="font-bold text-gray-800">{section.title}</h2>
      </div>
      {section.blurb && (
        <p className="text-xs text-gray-500 mb-3 leading-relaxed">{section.blurb}</p>
      )}
      {hasProducts ? (
        <div className="space-y-2.5">
          {section.products.map((p, i) => <ProductCard key={i} product={p} />)}
        </div>
      ) : (
        <div className="text-xs text-gray-400 py-3 text-center bg-gray-50 rounded-xl">
          站長還在挑選中…之後會慢慢補上 👀
        </div>
      )}
    </div>
  )
}

function ProductCard({ product }) {
  return (
    <a
      href={product.shopUrl}
      target="_blank"
      rel="noopener noreferrer sponsored"
      className="block bg-gradient-to-br from-orange-50 to-amber-50 border border-orange-100 rounded-xl p-3 active:scale-[0.99] transition-transform"
    >
      <div className="flex items-start gap-3">
        {product.image && (
          <img src={product.image} alt={product.name}
               className="w-16 h-16 object-cover rounded-lg shrink-0" loading="lazy" />
        )}
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-sm text-gray-800 leading-tight">{product.name}</h3>
          {product.blurb && (
            <p className="text-xs text-gray-600 mt-1 leading-relaxed">{product.blurb}</p>
          )}
          {product.tags?.length > 0 && (
            <div className="flex gap-1 mt-1.5 flex-wrap">
              {product.tags.map(t => (
                <span key={t} className="text-[10px] bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full">
                  {t}
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 mt-2">
            {product.price && (
              <span className="text-sm font-bold text-orange-600">NT${product.price}</span>
            )}
            <span className="text-xs text-orange-600 font-medium ml-auto">
              {product.ctaText || '🛒 看蝦皮'} →
            </span>
          </div>
        </div>
      </div>
    </a>
  )
}
