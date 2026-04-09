import { useState } from 'react'

export default function QuestionImages({ images }) {
  const [expanded, setExpanded] = useState(null)

  if (!images || images.length === 0) return null

  return (
    <>
      <div className={`flex flex-wrap gap-2 mt-2 ${images.length === 1 ? '' : ''}`}>
        {images.map((src, i) => (
          <img
            key={i}
            src={src}
            alt={`題目附圖 ${i + 1}`}
            className="rounded-lg border border-gray-200 bg-white cursor-pointer active:scale-95 transition-transform"
            style={{ maxHeight: images.length === 1 ? 200 : 140, maxWidth: '100%', objectFit: 'contain' }}
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
