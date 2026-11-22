import { useState } from 'react'
import { assetUrl } from '../lib/assetUrl'
import ImageLightbox from './ImageLightbox'

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
      {/* 選項圖也吃到反轉／對比／縮放（切圖後的選項圖常常只有一小塊，更需要放大） */}
      {zoom && <ImageLightbox src={src} alt={`選項 ${letter}`} onClose={() => setZoom(false)} />}
    </>
  )
}
