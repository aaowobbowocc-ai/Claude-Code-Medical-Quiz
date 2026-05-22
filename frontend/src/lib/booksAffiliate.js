// 博客來 AP 策略聯盟 — 推薦連結產生 + 書單查詢。
// AP link 格式為固定規則：在網域後插入 exep/assp.php/{APID}/，免用官方產生器。
//   商品頁  https://www.books.com.tw/products/0010949426
//   AP 連結 https://www.books.com.tw/exep/assp.php/aaowobbowocc/products/0010949426
// 合約 2026/05/21–2027/05/20；回饋金書類 2%。

import bookData from '../data/book-recommendations.json'

// 博客來 AP 會員 ID（核准 2026-05-21）
const BOOKS_APID = 'aaowobbowocc'

// utm 分析參數 — 對齊博客來「銷售聯結產生器」官方輸出，讓 AP 後台可看出
// 成交來自哪個版位/內容。追蹤分潤本身靠 assp.php/{apid}/ 路徑，與 utm 無關。
const BOOKS_UTM = `utm_source=${BOOKS_APID}&utm_medium=ap-books&utm_content=recommend&utm_campaign=ap-202605`

/**
 * 由博客來商品編號組出 AP 推薦連結（格式經博客來銷售聯結產生器核對）。
 * @param {string} itemId 商品編號，例如 "0010949426"（電子書為 "E0xxxxxxxx"）
 * @returns {string|null}
 */
export function buildBooksLink(itemId) {
  if (!itemId || !/^[A-Z]?\d{6,}$/.test(itemId)) return null
  return `https://www.books.com.tw/exep/assp.php/${BOOKS_APID}/products/${itemId}?${BOOKS_UTM}`
}

/**
 * 取得某考試的推薦參考書區塊（含標題與已附 AP 連結的書單）。
 * 回傳 null 表示該考試尚無書單。
 * @param {string} examId
 * @returns {{label: string, books: {id:string,title:string,url:string}[]}|null}
 */
export function getBookSection(examId) {
  if (!examId) return null
  let entry = bookData[examId]
  // {"use":"<key>"} → 指向 _shared 共享清單（醫事考試共用的人文選書）
  if (entry && entry.use) entry = (bookData._shared || {})[entry.use]
  if (!entry || !Array.isArray(entry.books)) return null
  const books = entry.books
    .map(b => ({ ...b, url: buildBooksLink(b.id) }))
    .filter(b => b.url)
  if (!books.length) return null
  return { label: entry.label || '推薦參考書', books }
}
