// Shared answer-checking helper. Honours MoEX official corrections:
//   "送分" / empty answer → 一律給分 (every option correct)
//   "A,B" comma-separated → either accepted (multi-answer correction)
//   single letter         → strict equality
//
// 兩種「多字母答案」長得一模一樣（都是 'A,B'），意思卻完全相反，**只能靠題目的旗標分**：
//   · 更正成兩個答案都給分（isMultiAnswer / disputed）→ 選中任一個就對
//   · 真的複選題（q.is_multi）→ 要**全對才算對**，少選一個也不給分
// 所以複選題一定要把第三個參數 multi 帶進來（呼叫端傳 q.is_multi）。
// 光看使用者選了幾個不夠：複選題只點一個也必須判錯。

/** 把 'A,B' / 'ACE' / ['A','C'] 一律攤成 ['A','B'] */
export const answerLetters = (v) =>
  Array.isArray(v) ? v.filter(Boolean).map(String)
    : (String(v ?? '').toUpperCase().match(/[A-Z]/g) || [])

/** 真的複選題（要全選才算對）。更正成雙答案的那種不算。 */
export const isMultiSelect = (q) => !!(q && q.is_multi)

/** 複選題的作答狀態用「排序後的字母字串」存（'AD'），存進紀錄與資料庫都相容 */
export const togglePick = (current, letter) => {
  const set = new Set(answerLetters(current))
  if (set.has(letter)) set.delete(letter)
  else set.add(letter)
  return [...set].sort().join('')
}

export function isAnswerCorrect(userAnswer, correctAnswer, multi = false) {
  if (!correctAnswer || correctAnswer === '送分') return true
  const picked = answerLetters(userAnswer)
  // 複選題：全對才算對（少選、多選、選錯都不給分）
  if (multi || picked.length > 1) {
    const want = answerLetters(correctAnswer)
    return want.length === picked.length
      && [...picked].sort().join('') === [...want].sort().join('')
  }
  const user = picked[0] || ''
  if (typeof correctAnswer === 'string' && correctAnswer.includes(',')) {
    return answerLetters(correctAnswer).includes(user)
  }
  return user === String(correctAnswer).trim()
}

// True if a given option letter should render as a correct answer.
// (e.g. multi-answer A,B → both A and B highlighted; 送分 → all four)
// ⚠️ 複選題的答案可能寫成沒有逗號的 'ACE'，不能只在有逗號時才拆。
export function isOptionCorrect(optionLetter, correctAnswer) {
  if (!correctAnswer || correctAnswer === '送分') return true
  return answerLetters(correctAnswer).includes(optionLetter)
}
