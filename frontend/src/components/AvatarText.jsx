import React from 'react'

/**
 * AvatarText — inline 顯示 avatar（單行內小尺寸場景）。
 *
 * - URL (`/...` 或 `http(s)://...`) → <img>
 * - emoji 字串 → <span>
 * - falsy → null
 *
 * 用於排行榜 / Lobby 之外的「inline avatar」場景（Game / Results / Comment / Notes
 * 等），這些地方原本直接 `{user.avatar}` 印出來，遇到 PNG 頭像會渲染成 URL 文字。
 * 排行榜 / Lobby / Shop 等使用 AvatarWithFrame，那個元件內部已有 URL 偵測。
 */
export default function AvatarText({ avatar, size = 16, className = '' }) {
  if (!avatar) return null
  const isUrl = typeof avatar === 'string' && /^(\/|https?:\/\/)/.test(avatar)
  if (isUrl) {
    return (
      <img
        src={avatar}
        alt=""
        className={`inline-block object-contain rounded-full ${className}`}
        style={{ width: size, height: size, verticalAlign: 'middle' }}
        draggable={false}
      />
    )
  }
  return <span className={className}>{avatar}</span>
}
