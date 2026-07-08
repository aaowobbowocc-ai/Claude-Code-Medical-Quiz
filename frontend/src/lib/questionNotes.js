// 個人筆記（僅本機、僅自己可見）— 回饋：想記錄訂正重點與複習心得
// 以 qKey（與錯題夾同一套 key）為索引，存在 localStorage。
import { wrongKey } from './wrongBank'

const KEY = 'question-notes'   // { [qKey]: { text, updatedAt } }

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch { return {} }
}
function save(map) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map))
    window.dispatchEvent(new Event('question-notes-changed'))
  } catch {}
}

export function getNote(q) {
  const k = wrongKey(q); if (!k) return ''
  return load()[k]?.text || ''
}

export function setNote(q, text) {
  const k = wrongKey(q); if (!k) return
  const map = load()
  const t = (text || '').trim()
  if (t) map[k] = { text: t, updatedAt: Date.now() }
  else delete map[k]
  save(map)
}

export function hasNote(q) {
  return !!getNote(q)
}
