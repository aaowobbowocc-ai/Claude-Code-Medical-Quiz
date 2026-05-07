// Shared answer-checking helper. Honours MoEX official corrections:
//   "送分" / empty answer → 一律給分 (every option correct)
//   "A,B" comma-separated → either accepted (multi-answer correction)
//   single letter         → strict equality
export function isAnswerCorrect(userAnswer, correctAnswer) {
  if (!correctAnswer || correctAnswer === '送分') return true
  if (typeof correctAnswer === 'string' && correctAnswer.includes(',')) {
    return correctAnswer.split(',').map(s => s.trim()).includes(userAnswer)
  }
  return userAnswer === correctAnswer
}

// True if a given option letter should render as a correct answer.
// (e.g. multi-answer A,B → both A and B highlighted; 送分 → all four)
export function isOptionCorrect(optionLetter, correctAnswer) {
  if (!correctAnswer || correctAnswer === '送分') return true
  if (typeof correctAnswer === 'string' && correctAnswer.includes(',')) {
    return correctAnswer.split(',').map(s => s.trim()).includes(optionLetter)
  }
  return correctAnswer === optionLetter
}
