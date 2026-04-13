// Export / import local user data as a single base64 blob.
//
// Motivation: PWA standalone can't complete the Google OAuth flow, so users
// whose data is stuck inside a PWA need a way to move it to a browser tab
// where they CAN sign in. Same blob also works as a general device-to-device
// transfer for anyone without an account.

const KEYS = [
  'medical-quiz-player',     // zustand main store (name/coins/level/unlocks/...)
  'bookmarked-questions-v2', // bookmarks (current format)
  'bookmarked-questions',    // bookmarks (legacy v1, migrated on load)
  'quiz-accuracy-v1',        // per-subject accuracy stats
  'practice-history',        // practice session log
  'practice-last-config',    // last practice config
  'battle-history',          // PvP battle log
  'mock-exam-history',       // mock exam history
  'classified-votes',        // user classification votes
]

// Anything not in KEYS is excluded — auth tokens, UI prefs, rate limits,
// comment like/report flags, registry cache. The schema version lets the
// importer refuse anything from a future incompatible format.
const SCHEMA_VERSION = 1

export function exportBackup() {
  const payload = { v: SCHEMA_VERSION, at: Date.now(), data: {} }
  for (const k of KEYS) {
    const v = localStorage.getItem(k)
    if (v != null) payload.data[k] = v
  }
  const json = JSON.stringify(payload)
  // btoa can't handle non-latin1; encode UTF-8 → base64
  const b64 = btoa(unescape(encodeURIComponent(json)))
  return `MKBAK1:${b64}`
}

export function parseBackup(code) {
  const trimmed = (code || '').trim()
  if (!trimmed) return { ok: false, error: '備份碼是空的' }
  if (!trimmed.startsWith('MKBAK1:')) return { ok: false, error: '這不是有效的備份碼(缺少 MKBAK1: 前綴)' }
  let payload
  try {
    const b64 = trimmed.slice('MKBAK1:'.length)
    const json = decodeURIComponent(escape(atob(b64)))
    payload = JSON.parse(json)
  } catch {
    return { ok: false, error: '備份碼格式錯誤或已損毀' }
  }
  if (!payload || typeof payload !== 'object' || !payload.data) {
    return { ok: false, error: '備份內容格式不正確' }
  }
  if (payload.v !== SCHEMA_VERSION) {
    return { ok: false, error: `備份版本不相容(v${payload.v})` }
  }
  return { ok: true, payload }
}

export function applyBackup(payload) {
  for (const k of KEYS) {
    const v = payload.data[k]
    if (v != null) localStorage.setItem(k, v)
  }
}

// Count how many items each section of a parsed payload contains. Used by the
// import UI to show the user what they're about to overwrite before they commit.
export function summarizeBackup(payload) {
  const d = payload.data || {}
  const summary = {}
  try {
    const player = JSON.parse(d['medical-quiz-player'] || '{}')
    const s = player?.state || {}
    summary.name = s.name || '(空)'
    summary.coins = s.coins ?? 0
    summary.level = s.level ?? 1
  } catch {}
  try {
    const b = JSON.parse(d['bookmarked-questions-v2'] || '{}')
    summary.bookmarks = Object.values(b.questions || {}).reduce((a, arr) => a + (arr?.length || 0), 0)
  } catch {}
  try {
    const hist = JSON.parse(d['practice-history'] || '[]')
    summary.practiceSessions = hist.length
  } catch {}
  try {
    const battles = JSON.parse(d['battle-history'] || '[]')
    summary.battles = battles.length
  } catch {}
  try {
    const mocks = JSON.parse(d['mock-exam-history'] || '[]')
    summary.mockExams = mocks.length
  } catch {}
  const dateStr = payload.at ? new Date(payload.at).toLocaleString('zh-TW') : '未知時間'
  summary.exportedAt = dateStr
  return summary
}
