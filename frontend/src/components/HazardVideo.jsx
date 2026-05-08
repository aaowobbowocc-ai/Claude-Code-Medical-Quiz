import { useEffect, useRef, useState } from 'react'

/**
 * 機車危險感知影片播放器。
 *
 * 來源：公路局 機車危險感知教育平台。
 * - 自動 muted + playsInline（手機自動播放需要）
 * - controls 顯示
 * - 影片載入失敗時降級顯示連結到原始公路局頁面
 */
export default function HazardVideo({ src, sourceUrl }) {
  const [error, setError] = useState(false)
  const ref = useRef(null)

  useEffect(() => { setError(false) }, [src])

  if (!src) return null

  if (error) {
    return (
      <div className="mt-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
        影片載入失敗，可前往
        {sourceUrl ? (
          <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="underline mx-1">公路局原平台</a>
        ) : ' 公路局原平台 '}
        觀看
      </div>
    )
  }

  return (
    <div className="mt-2 rounded-xl overflow-hidden bg-black border border-gray-200 dark:border-gray-700">
      <video
        ref={ref}
        src={src}
        controls
        playsInline
        muted
        preload="metadata"
        className="w-full h-auto"
        style={{ maxHeight: 360 }}
        onError={() => setError(true)}
      >
        您的瀏覽器不支援影片播放
      </video>
    </div>
  )
}
