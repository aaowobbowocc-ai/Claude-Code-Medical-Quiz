/**
 * AvatarWithFrame — 把 emoji 頭像（或圖片）包進邊框。
 *
 * 用法：
 *   <AvatarWithFrame emoji="👨‍⚕️" frameId="gold" size="sm" />
 *
 * 如果 frameId 沒提供或 'none'，渲染純 emoji，不帶 border。
 * 如果 FEATURE_FRAMES flag 關閉，永遠回 emoji（不顯示邊框）。
 *
 * sizes:
 *   sm  → 36 × 36px（排行榜列表）
 *   md  → 56 × 56px（對戰房間）
 *   lg  → 80 × 80px（profile）
 */
import React from 'react'
import '../styles/frames.css'
import { FEATURE_FRAMES } from '../config/featureFlags'

export default function AvatarWithFrame({ emoji, image, frameId, size = 'sm', className = '' }) {
  // 一律走 frame-none 直到 feature flag 開啟
  const effectiveFrame = FEATURE_FRAMES && frameId && frameId !== 'none' ? frameId : 'none'
  const frameClass = `frame-${effectiveFrame}`
  const sizeClass = `frame-${size}`

  // emoji size 對應 wrapper size — 略小才不會超出邊框
  const emojiSize = size === 'sm' ? '1.5rem' : size === 'md' ? '2rem' : '2.75rem'

  // Auto-detect：emoji 欄位若是 URL（/ 或 http 開頭）也視為 image。
  // 後端 profiles.avatar 對 PNG 頭像會存 URL（如 /avatars/png/animal-otter.png），
  // 排行榜直接傳給 AvatarWithFrame 不會主動分流 → 這邊偵測一下避免渲染成 URL 文字。
  const resolvedImage = image || (typeof emoji === 'string' && /^(\/|https?:\/\/)/.test(emoji) ? emoji : null)

  return (
    <span className={`frame-wrapper ${frameClass} ${sizeClass} ${className}`}>
      {resolvedImage ? (
        <img
          src={resolvedImage}
          alt="avatar"
          style={{
            width: size === 'sm' ? '36px' : size === 'md' ? '56px' : '80px',
            height: size === 'sm' ? '36px' : size === 'md' ? '56px' : '80px',
            objectFit: 'contain',
          }}
        />
      ) : (
        <span
          className="frame-inner flex items-center justify-center"
          style={{
            fontSize: emojiSize,
            lineHeight: 1,
            width: size === 'sm' ? '36px' : size === 'md' ? '56px' : '80px',
            height: size === 'sm' ? '36px' : size === 'md' ? '56px' : '80px',
          }}
        >
          {emoji || '👤'}
        </span>
      )}
    </span>
  )
}
