/**
 * 經濟部國營事業聯招 試題解答 PDF 解析器
 *
 * 台電官網的「試題解答」PDF = 試題 + 內嵌答案。每題前綴 [X]（X=答案字母），
 * 例如 `[D] 1. 題目...` 或 `[A或D] 2. ...`（爭議題/送分）。
 * 選項格式為 `(A)...(B)...(C)...(D)...`，可同行或跨行。
 * 克漏字／閱讀測驗的題組共用一段文章 → 以 case_context 帶入。
 */

const stripPUA = s => typeof s === 'string' ? s.replace(/[-]/g, '') : s

function clean(s) {
  return stripPUA(String(s || ''))
    .replace(/\s+/g, ' ')
    .trim()
}

// 移除頁首頁尾、章節標題等雜訊行（保留空行結構，供題組文章偵測用）
function stripNoise(text) {
  return text.replace(/\r\n?/g, '\n').split('\n').map(line => {
    const t = line.trim()
    if (/第\s*\d+\s*頁/.test(t)) return ''                       // 頁首/頁尾（含科目名頁首）
    if (/【請翻頁繼續作答】|【請接背面】|【背面尚有試題】/.test(t)) return ''
    if (/^經濟部所屬事業機構/.test(t)) return ''
    if (/^[一二三四五六七八九十]+、\s*(字彙|文法|慣用語|克漏字|閱讀測驗|綜合測驗)/.test(t)) return ''
    if (/^[壹貳參肆伍]+、/.test(t)) return ''
    return line
  }).join('\n')
}

// 解讀 [X] 標記內容 → { answer, disputed }
function interpretMarker(raw) {
  const letters = (raw.match(/[A-D]/g) || [])
  const hasGive = /送分|給分|一律/.test(raw)
  if (letters.length === 0) {
    return hasGive ? { answer: null, disputed: true } : null   // 非答案標記
  }
  if (letters.length > 1 || hasGive || /或|、|，|,/.test(raw)) {
    return { answer: letters[0], disputed: true }              // 多答案/送分 → 爭議題
  }
  return { answer: letters[0], disputed: false }
}

// 從題塊文字切出 stem + 4 選項 + trailing（題組文章會落在 trailing）
function splitOptions(block) {
  // 找出最後一組成立的 (A)..(B)..(C)..(D)
  const aPos = []
  let re = /\(A\)/g, m
  while ((m = re.exec(block)) !== null) aPos.push(m.index)
  for (let i = aPos.length - 1; i >= 0; i--) {
    const ia = aPos[i]
    const ib = block.indexOf('(B)', ia + 3)
    if (ib < 0) continue
    const ic = block.indexOf('(C)', ib + 3)
    if (ic < 0) continue
    const id = block.indexOf('(D)', ic + 3)
    if (id < 0) continue
    const stem = block.slice(0, ia)
    let dRegion = block.slice(id + 3)
    // 選項 D 在第一個空行處結束，其後為題組文章（trailing）
    const blankIdx = dRegion.search(/\n[ \t]*\n/)
    let optD = dRegion, trailing = ''
    if (blankIdx >= 0) {
      optD = dRegion.slice(0, blankIdx)
      trailing = dRegion.slice(blankIdx).trim()
    }
    return {
      stem,
      options: {
        A: clean(block.slice(ia + 3, ib)),
        B: clean(block.slice(ib + 3, ic)),
        C: clean(block.slice(ic + 3, id)),
        D: clean(optD),
      },
      trailing,
    }
  }
  return null
}

/**
 * 解析一份「試題解答」PDF 文字 → 題目陣列
 * @returns {Array<{number,question,options,answer,disputed,case_context}>}
 */
function parseTaipowerPdf(text) {
  const body = stripNoise(text)

  // 標記：[答案] 題號.   標記內容（如「本題\n送分」）與題號間可跨行；
  // 題號後的句點為選填（103 年起部分卷題號無句點）。
  const markerRe = /\[([^\]]{1,24})\]\s*(\d{1,3})\s*[.．、]?/g
  const markers = []
  let m, prev = 0
  while ((m = markerRe.exec(body)) !== null) {
    const info = interpretMarker(m[1])
    if (!info) continue                              // 非答案標記，跳過
    const num = parseInt(m[2], 10)
    if (!(num === prev + 1 || (prev === 0 && num === 1) || (num > prev && num <= prev + 3))) {
      continue                                       // 題號不連續 → 視為誤判
    }
    markers.push({ num, info, contentStart: m.index + m[0].length, markerStart: m.index })
    prev = num
  }

  const questions = []
  let pendingPassage = null
  for (let i = 0; i < markers.length; i++) {
    const mk = markers[i]
    const end = i + 1 < markers.length ? markers[i + 1].markerStart : body.length
    const block = body.slice(mk.contentStart, end)
    const split = splitOptions(block)
    if (!split) continue

    const optCount = Object.values(split.options).filter(Boolean).length
    if (optCount < 4 || !split.options.A) continue   // 殘缺題跳過

    let stem = clean(split.stem)
    const caseCtx = pendingPassage
    if (!stem && caseCtx) stem = `依據上文，選出第 ${mk.num} 題最適當的答案。`

    questions.push({
      number: mk.num,
      question: stem,
      options: split.options,
      answer: mk.info.answer,                 // 純送分（PDF 無答案字母）時為 null
      disputed: mk.info.disputed || undefined,
      case_context: caseCtx || undefined,
    })

    // trailing（長度足夠）→ 視為下一題組的共用文章
    if (split.trailing && clean(split.trailing).length > 50) {
      pendingPassage = clean(split.trailing)
    }
  }

  return questions
}

module.exports = { parseTaipowerPdf, clean }
