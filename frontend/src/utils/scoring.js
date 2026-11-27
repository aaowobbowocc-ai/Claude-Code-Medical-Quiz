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

// ─────────────────────────────────────────────────────────────────────────────
// 考選部的配分：一題不等於一分
//
// 鐵路佐級國文的卷頭寫得很清楚（103-112 年每一卷都一樣）：
//   一、單選題（第1題至第35題，每題2分，占70分）
//   二、複選題（第36題至第45題，每題3分，占30分）
//     說明：所列的五個選項，其中至少有二個是正確答案。**各題之選項獨立判定**，
//     全部答對者得3分；答錯一個選項者得1.8分；答錯二個選項者得0.6分；
//     所有選項均未作答或答錯多於二個選項（不含二個）者，該題以零分計算。
//
// 「選項獨立判定」= 把五個選項一個一個比「該選的有沒有選、不該選的有沒有選」，
// 錯的格數就是**對稱差集**的大小（picked △ want）。所以不需要知道有幾個選項。
//
// ⚠️ 「所有選項均未作答者以零分計算」要單獨擋掉，不能讓它掉進部分給分。
//    正解是兩個字母（例如 AD）時，完全沒作答算出來的對稱差集剛好是 2，
//    照表查會變成 0.6 分 —— 白卷有分，這條規則就是為了防這件事才寫在卷上的。
// ─────────────────────────────────────────────────────────────────────────────

/** 一題一分：沒有設定配分的考卷就用這個（既有行為不變） */
const FLAT = { single: 1, multi: 1, partial: null }

/**
 * 讀一張考卷的配分設定（exam-configs 的 paper 欄位）。
 *   pointsPerQ        單選每題幾分
 *   multiPointsPerQ   複選每題幾分（沒寫就跟單選一樣）
 *   multiPartial      [全對, 錯一格, 錯兩格, …] 的得分表；沒寫就是全對才給分
 */
export function paperScoring(paper) {
  const single = paper?.pointsPerQ || 1
  const multi = paper?.multiPointsPerQ || single
  const partial = Array.isArray(paper?.multiPartial) && paper.multiPartial.length
    ? paper.multiPartial : null
  if (single === 1 && multi === 1 && !partial) return FLAT
  return { single, multi, partial }
}

/** 這一題的滿分 */
export function questionPoints(q, sc = FLAT) {
  return isMultiSelect(q) ? sc.multi : sc.single
}

/** 這一題實得幾分 */
export function questionScore(q, userAnswer, sc = FLAT) {
  const full = questionPoints(q, sc)
  // 送分（整題給分）不管有沒有作答都給滿分，跟 isAnswerCorrect 一致
  if (!q?.answer || q.answer === '送分') return full
  if (!isMultiSelect(q)) return isAnswerCorrect(userAnswer, q.answer, false) ? sc.single : 0

  const picked = answerLetters(userAnswer)
  if (!picked.length) return 0            // 所有選項均未作答 → 零分（見上面的註解）
  const want = new Set(answerLetters(q.answer))
  const got = new Set(picked)
  let wrong = 0
  for (const k of want) if (!got.has(k)) wrong++   // 該選沒選
  for (const k of got) if (!want.has(k)) wrong++   // 不該選卻選了
  if (!wrong) return full
  if (!sc.partial) return 0               // 沒有部分給分的卷 → 全對才給分
  return sc.partial[wrong] ?? 0
}

/**
 * 整卷算分。answers 是 { [題目在陣列中的 index]: 作答 }。
 * 回傳 { score, full, correct, hasPoints }：
 *   score/full  依考選部配分算出來的得分與滿分
 *   correct     答對題數（全對才算對，部分給分的題不算「對」）
 *   hasPoints   這張卷有沒有真的設配分（沒有就是一題一分，前台照舊顯示題數）
 */
export function gradePaper(questions, answers = {}, paper = null) {
  const sc = paperScoring(paper)
  let score = 0, full = 0, correct = 0
  ;(questions || []).forEach((q, i) => {
    full += questionPoints(q, sc)
    score += questionScore(q, answers[i], sc)
    if (isAnswerCorrect(answers[i], q.answer, q.is_multi)) correct++
  })
  return {
    score: +score.toFixed(2),   // 1.8 + 0.6 這種加法會跑出浮點誤差
    full: +full.toFixed(2),
    correct,
    hasPoints: sc !== FLAT,
  }
}
