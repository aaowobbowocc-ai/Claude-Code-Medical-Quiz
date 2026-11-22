import { useState } from 'react'
import { assetUrl } from '../lib/assetUrl'
import ImageLightbox from './ImageLightbox'

const WARN = 'mt-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700'

export default function QuestionImages({ images, imageUrl, incomplete }) {
  const [expanded, setExpanded] = useState(null)

  // Support both images array and single image_url string.
  // assetUrl(): 原生 App 把題目圖改成從 web host 載入（這些圖沒打包進 APK，見 assetUrl.js）
  const imgList = (images?.length ? images : imageUrl ? [imageUrl] : []).map(assetUrl)

  // 縮圖列 + 放大檢視（檢視器支援反轉顏色／對比／縮放，見 ImageLightbox.jsx）
  const thumbs = (max) => (
    <>
      <div className="flex flex-wrap gap-2 mt-2">
        {imgList.map((src, i) => (
          <img key={i} src={src} alt={`題目附圖 ${i + 1}`}
            className="rounded-lg border border-gray-200 bg-white cursor-zoom-in active:scale-95 transition-transform"
            style={{ maxHeight: max, maxWidth: '100%', objectFit: 'contain' }}
            onClick={() => setExpanded(src)} loading="lazy" />
        ))}
      </div>
      {expanded && <ImageLightbox src={expanded} onClose={() => setExpanded(null)} />}
    </>
  )

  // Show warning for incomplete questions (missing image or image-only options)
  if (incomplete === 'missing_image' && imgList.length === 0) {
    return <div className={WARN}>本題含有圖片但無法顯示，請參考原始考卷</div>
  }
  // Other incomplete reasons — show a generic warning so users understand why
  // a question seems broken (added 2026-05-16 with bulk audit fixes)
  if (incomplete === 'empty_question') {
    return <div className={WARN}>本題題幹資料缺漏，請參考原始考卷</div>
  }
  if (incomplete === 'truncated_options') {
    return <div className={WARN}>本題部分選項缺漏，請參考原始考卷</div>
  }
  if (incomplete === 'image_options') {
    return (
      <>
        <div className={WARN}>本題選項為圖片，可能無法正常對應選項</div>
        {imgList.length > 0 && thumbs(140)}
      </>
    )
  }

  if (imgList.length === 0) return null

  return thumbs(imgList.length === 1 ? 200 : 140)
}
