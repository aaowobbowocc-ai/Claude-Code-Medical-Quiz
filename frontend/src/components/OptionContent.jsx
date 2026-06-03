import { useState } from 'react'
import { assetUrl } from '../lib/assetUrl'

export default function OptionContent({ text, imageUrl, letter }) {
  const [zoom, setZoom] = useState(false)
  if (!imageUrl) return text
  // 原生 App 把選項圖改成從 web host 載入（沒打包進 APK，見 assetUrl.js）
  const src = assetUrl(imageUrl)
  return (
    <>
      <img
        src={src}
        alt={`選項 ${letter}`}
        loading="lazy"
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setZoom(true) }}
        className="block max-w-full mb-1.5 rounded-md bg-white border border-gray-200 cursor-zoom-in"
        style={{ maxHeight: 180, objectFit: 'contain' }}
      />
      <span>{text}</span>
      {zoom && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={(e) => { e.stopPropagation(); setZoom(false) }}
        >
          <img src={src} alt="放大" className="max-w-full max-h-full rounded-xl bg-white p-2 shadow-2xl" />
        </div>
      )}
    </>
  )
}
