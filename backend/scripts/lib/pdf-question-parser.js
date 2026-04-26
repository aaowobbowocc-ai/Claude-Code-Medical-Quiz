/**
 * Unified PDF question parser
 * Consolidates question, answer, and correction parsing from multiple exam PDFs
 */

/**
 * Strip Private Use Area (PUA) characters (U+E000..U+F8FF)
 * MoEX PDFs use custom fonts where A/B/C/D circled glyphs render as 口 boxes
 * @param {*} value - Any value (string, number, object)
 * @returns {*} Same type with PUA chars removed from strings
 */
function stripPUA(value) {
  if (typeof value !== 'string') return value
  return value.replace(/[-]/g, '').trim()
}

/**
 * Parse questions from PDF text
 * Detects question numbers (1. 2. etc), options (A) B. C, D), and multi-line content
 * Supports both modern (106+, 80-100 questions) and old (100-105, up to 200 questions) formats
 *
 * @param {string} text - Extracted text from PDF (newline-delimited)
 * @param {object} opts - Options
 * @param {number} opts.maxQNum - Max question number to accept (default: 200 for flexibility)
 * @returns {array} Array of { number, question, options: {A,B,C,D} }
 */
function parseQuestions(text, opts = {}) {
  const { maxQNum = 200 } = opts

  const questions = []
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  let currentQ = null
  let currentOption = null
  let buffer = ''

  function flushOption() {
    if (currentQ && currentOption) {
      currentQ.options[currentOption] = stripPUA(buffer.trim())
    }
    buffer = ''
    currentOption = null
  }

  function flushQuestion() {
    flushOption()
    if (currentQ && currentQ.question && Object.keys(currentQ.options).length >= 2) {
      questions.push(currentQ)
    }
    currentQ = null
  }

  let inMcSection = false  // Becomes true after "測驗題" header

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    // Skip header/footer
    if (/^(代號|類科|科目|考試|頁次|等\s*別|全.*題|本試題|座號|※)/.test(line)) continue
    if (/^\d+\s*頁/.test(line)) continue
    if (/^第\s*\d+\s*頁/.test(line)) continue

    // Detect 測驗題 / 選擇題 section marker
    if (/測驗題|單一選擇題|選擇題/.test(line) && !inMcSection) {
      currentQ = null
      currentOption = null
      buffer = ''
      inMcSection = true
      continue
    }

    // New question — number followed by period
    // Reject pure decimal numbers like "1.0", "2.5"
    const qMatch = line.match(/^(\d{1,2})[.、．]\s*(.*)$/)
    if (qMatch && (line.length > 6 || /[一-鿿 a-zA-Z]/.test(qMatch[2] || '') || (qMatch[2] || '') === '')) {
      const num = parseInt(qMatch[1])
      // Accept sequential question numbers; only allow num=1 if no questions yet
      const isFirst = !currentQ && questions.length === 0
      if (num >= 1 && num <= maxQNum && (isFirst || (currentQ && num === currentQ.number + 1))) {
        flushQuestion()
        currentQ = { number: num, question: (qMatch[2] || '').trim(), options: {} }
        continue
      }
    }

    // Option line — must have explicit separator
    const optMatch = line.match(/^[\(（]\s*([A-Da-dＡＢＣＤ])\s*[\)）]\s*(.*)$/)
      || line.match(/^([A-Da-dＡＢＣＤ])\s*[.．、]\s*(.*)$/)
    if (optMatch && currentQ) {
      flushOption()
      currentOption = optMatch[1].toUpperCase()
        .replace('Ａ', 'A').replace('Ｂ', 'B').replace('Ｃ', 'C').replace('Ｄ', 'D')
      buffer = optMatch[2] || ''
      continue
    }

    // Continuation of question or option
    if (currentOption) {
      buffer += ' ' + line
    } else if (currentQ) {
      currentQ.question += ' ' + line
    }
  }

  flushQuestion()
  return questions
}

/**
 * Parse answers from PDF text
 * Supports multiple formats used across different exam years:
 * - Full-width consecutive: 答案ＡＢＣＤ... (modern MoEX, may include ＃ for corrections)
 * - Half-width consecutive: 答案ABCD... or 答案ACCCDBCADB... (100-105年 format)
 * - Number-keyed: 1.C 2.A 3.B ...
 *
 * @param {string} text - Extracted text from PDF
 * @param {object} opts - Options
 * @param {number} opts.maxQNum - Max question number to accept (default: 200)
 * @returns {object} { questionNumber: answerLetter }
 */
function parseAnswers(text, opts = {}) {
  const { maxQNum = 200 } = opts
  const answers = {}

  // Method 1: Full-width consecutive (modern MoEX format)
  // 答案ＡＢＣＤ... or 答案ＡＢＣＤ＃... (＃ marks corrected, skip position)
  const fullWidthPattern = /答案\s*([ＡＢＣＤ＃]+)/g
  let fwMatch
  let questionNum = 1
  while ((fwMatch = fullWidthPattern.exec(text)) !== null) {
    const letters = fwMatch[1]
    for (let i = 0; i < letters.length; i++) {
      const ch = letters[i]
      const mapped = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (mapped && questionNum <= maxQNum) {
        answers[questionNum] = mapped
      }
      if (ch !== '＃' || mapped) {
        // Either a valid answer or skip for ＃, increment position
        if (mapped || ch === '＃') questionNum++
      }
    }
  }

  if (Object.keys(answers).length >= 20) return answers

  // Method 2: Half-width consecutive (100-105年 format)
  // 答案ABCD... or 答案ACCCDBCADB... (each char = one question)
  // '#' marks corrected answers (skip that position, increment counter)
  // Cap at maxQNum to avoid t=A combined PDFs blending other subjects' answers
  const hwConsecPattern = /答案\s*([A-D#]{10,})/gi
  let hwcMatch
  questionNum = 1
  const hwAnswers = {}
  while ((hwcMatch = hwConsecPattern.exec(text)) !== null) {
    for (const ch of hwcMatch[1]) {
      if (/[A-D]/i.test(ch) && questionNum <= maxQNum) {
        hwAnswers[questionNum] = ch.toUpperCase()
      }
      // '#' still increments position
      if (questionNum <= maxQNum) {
        questionNum++
      }
    }
  }
  // Use halfwidth if it has more answers than fullwidth
  if (Object.keys(hwAnswers).length > Object.keys(answers).length) {
    return hwAnswers
  }

  if (Object.keys(answers).length >= 20) return answers

  // Method 3: Number-keyed format (1.C 2.A etc)
  const nkPattern = /(\d{1,2})\s*[.\s、．:：]\s*([A-Da-d])/g
  let nkMatch
  while ((nkMatch = nkPattern.exec(text)) !== null) {
    const num = parseInt(nkMatch[1])
    if (num >= 1 && num <= maxQNum) {
      answers[num] = nkMatch[2].toUpperCase()
    }
  }

  return answers
}

/**
 * Parse corrections/amendments from PDF text
 * Formats:
 * - "第 N 題 ... 一律給分" → mark as disputed (*)
 * - "第 N 題 ... 更正為 X" → mark with new answer
 * - Table format: "N  A" → number + answer
 *
 * @param {string} text - Extracted text from PDF
 * @returns {object} { questionNumber: answerOrAsterisk }
 */
function parseCorrections(text) {
  const corrections = {}

  // Split by line and process
  const lines = text.split(/\n/)
  for (const line of lines) {
    // All-pass (送分)
    const givePoints = line.match(/第?\s*(\d{1,2})\s*題.*(?:一律給分|送分)/i)
    if (givePoints) {
      corrections[parseInt(givePoints[1])] = '*'
      continue
    }

    // Answer change (更正)
    const changeAns = line.match(/第?\s*(\d{1,2})\s*題.*更正.*([A-D])/i)
    if (changeAns) {
      corrections[parseInt(changeAns[1])] = changeAns[2]
      continue
    }

    // Table format: space-separated or tab-separated
    const simple = line.match(/(\d{1,2})\s+([A-D*])/gi)
    if (simple) {
      for (const s of simple) {
        const m = s.match(/(\d{1,2})\s+([A-D*])/i)
        if (m) corrections[parseInt(m[1])] = m[2].toUpperCase()
      }
    }
  }

  return corrections
}

module.exports = {
  parseQuestions,
  parseAnswers,
  parseCorrections,
  stripPUA,
}
