/*
 * 大考中心試卷的頁首／頁尾「版面家具」。
 *
 * pdf-parse 把整頁文字攤平，頁首頁尾就會夾進題文中間，例如：
 *   「…隨船載回發賣。」依據前述記載，請問：第7頁111年學測共17頁社會考
 *   「…二氧化碳濃度（ppm）101年學測第14頁自然考科共15頁- 14 -圖20…」
 *   「…the San Francisco Opera Chorus.第5頁101年學測共7頁英文考科- 5 -Walking home…」
 *
 * 這些 token 會連成一串出現，所以用「一個或多個 token 連續出現」當判準，
 * 而不是單獨比對 —— 單獨比對會把內文裡正常的「第5頁」也殺掉。
 */

// 單一 token（不加錨點，給下面組合用）
const TOKENS = [
  '第\\s*\\d+\\s*頁',
  '共\\s*\\d+\\s*頁',
  '\\d{2,3}\\s*年\\s*(?:學測|指考|分科測驗)',
  // 「科」要可選：PDF 常把頁尾切掉，只剩「社會考」
  '(?:國文|英文|數學[AB]?|社會|自然|歷史|地理|公民與社會|物理|化學|生物)\\s*考科?',
  '-\\s*\\d+\\s*-',
  '試題[卷本]',
  '請翻[至頁]下?一?頁?',
  '以下空白',
]

// 連續兩個以上才算版面家具；單獨一個「第5頁」可能是內文
const RUN = new RegExp(`(?:\\s*(?:${TOKENS.join('|')})\\s*){2,}`, 'g')

/**
 * 清掉題文裡的頁首頁尾。回傳 [清完的字串, 清掉幾處]。
 *
 * 中文兩側直接接起來，英文兩側要補一個空白
 * （否則 "Chorus." + "Walking" 會黏成 "Chorus.Walking"）。
 */
const CJK = /[　-〿一-鿿＀-￯]/
function stripPageFurniture(s) {
  let n = 0
  const str = String(s || '')
  const out = str.replace(RUN, (m, ...rest) => {
    n++
    const at = rest[rest.length - 2]
    const before = str[at - 1] || ''
    const after = str[at + m.length] || ''
    return (CJK.test(before) || CJK.test(after) || !before || !after) ? '' : ' '
  })
  return [out.replace(/[ \t]{2,}/g, ' ').trim(), n]
}

module.exports = { stripPageFurniture, TOKENS }
