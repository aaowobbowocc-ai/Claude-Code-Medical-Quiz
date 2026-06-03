import { useState } from 'react'
import { assetUrl } from '../lib/assetUrl'

export default function QuestionImages({ images, imageUrl, incomplete }) {
  const [expanded, setExpanded] = useState(null)

  // Support both images array and single image_url string.
  // assetUrl(): 原生 App 把題目圖改成從 web host 載入（這些圖沒打包進 APK，見 assetUrl.js）
  const imgList = (images?.length ? images : imageUrl ? [imageUrl] : []).map(assetUrl)

  // Show warning for incomplete questions (missing image or image-only options)
  if (incomplete === 'missing_image' && imgList.length === 0) {
    return (
      <div className="mt-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
        本題含有圖片但無法顯示，請參考原始考卷
      </div>
    )
  }
  // Other incomplete reasons — show a generic warning so users understand why
  // a question seems broken (added 2026-05-16 with bulk audit fixes)
  if (incomplete === 'empty_question') {
    return (
      <div className="mt-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
        本題題幹資料缺漏，請參考原始考卷
      </div>
    )
  }
  if (incomplete === 'truncated_options') {
    return (
      <div className="mt-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
        本題部分選項缺漏，請參考原始考卷
      </div>
    )
  }
  if (incomplete === 'image_options') {
    return (
      <>
        <div className="mt-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
          本題選項為圖片，可能無法正常對應選項
        </div>
        {imgList.length > 0 && (
          <div className={`flex flex-wrap gap-2 mt-2`}>
            {imgList.map((src, i) => (
              <img key={i} src={src} alt={`附圖 ${i + 1}`}
                className="rounded-lg border border-gray-200 bg-white cursor-pointer active:scale-95 transition-transform"
                style={{ maxHeight: 140, maxWidth: '100%', objectFit: 'contain' }}
                onClick={() => setExpanded(src)} loading="lazy" />
            ))}
          </div>
        )}
        {expanded && (
          <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setExpanded(null)}>
            <img src={expanded} alt="放大圖片" className="max-w-full max-h-full rounded-xl bg-white p-2 shadow-2xl" onClick={e => e.stopPropagation()} />
          </div>
        )}
      </>
    )
  }

  if (imgList.length === 0) return null

  return (
    <>
      <div className={`flex flex-wrap gap-2 mt-2 ${imgList.length === 1 ? '' : ''}`}>
        {imgList.map((src, i) => (
          <img
            key={i}
            src={src}
            alt={`題目附圖 ${i + 1}`}
            className="rounded-lg border border-gray-200 bg-white cursor-pointer active:scale-95 transition-transform"
            style={{ maxHeight: imgList.length === 1 ? 200 : 140, maxWidth: '100%', objectFit: 'contain' }}
            onClick={() => setExpanded(src)}
            loading="lazy"
          />
        ))}
      </div>

      {expanded && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
             onClick={() => setExpanded(null)}>
          <img src={expanded} alt="放大圖片"
               className="max-w-full max-h-full rounded-xl bg-white p-2 shadow-2xl"
               onClick={e => e.stopPropagation()} />
        </div>
      )}
    </>
  )
}
