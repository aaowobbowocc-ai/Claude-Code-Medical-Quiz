// 標記夾：模擬考中手動 🚩 標記「不確定」的題目，永久保存供日後回顧。
//
// 與「錯題夾」(wrongBank) 的差別：
//   錯題夾 = 系統自動收「答錯」的題（不論你有沒有把握）
//   標記夾 = 你手動標「不確定/想再看」的題（不論對錯）
// 兩者獨立，一題可能同時在兩邊（標了又答錯），也可能只在標記夾（標了但答對）。

const KEY = 'flag-questions-bank'
const MAX = 200

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') }
  catch { return [] }
}
function save(arr) {
  try { localStorage.setItem(KEY, JSON.stringify(arr)) } catch {}
}

// 與 wrongBank 相同的 key 規則（結構化 id 優先，其次考試代碼+題號，最後題幹）
function qKey(q) {
  if (!q) return ''
  if (q.id && /^[a-z]/i.test(String(q.id))) return String(q.id)
  if (q.exam_code && q.number != null) return `${q.exam_code}_${q.subject_tag || q.subject || ''}_${q.number}`
  return q.id || q.question?.slice(0, 80) || ''
}

// 加入標記題（陣列）。每題含原 question 物件 + myAnswer + correct + flaggedAt + examId。
// 已存在的更新 flaggedAt 排到最前面，cap 在 MAX。
export function addFlags(flagQs, examId) {
  if (!Array.isArray(flagQs) || flagQs.length === 0) return
  const now = Date.now()
  const byKey = new Map(load().map(q => [qKey(q), q]))
  for (const fq of flagQs) {
    const k = qKey(fq)
    if (!k) continue
    byKey.set(k, { ...fq, examId: fq.examId || examId, flaggedAt: now })
  }
  const next = [...byKey.values()].sort((a, b) => (b.flaggedAt || 0) - (a.flaggedAt || 0)).slice(0, MAX)
  save(next)
}

export function getFlags() { return load() }

export function removeFlag(q) {
  const k = qKey(q); if (!k) return
  save(load().filter(x => qKey(x) !== k))
}

export function clearFlags() { save([]) }

export function flagCount() { return load().length }

export const FLAG_BANK_MAX = MAX
