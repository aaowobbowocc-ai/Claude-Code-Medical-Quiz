/**
 * Format a question's year + session for display.
 *
 * Background: 語言治療師/聽力師 100-101 年同時辦「特考（相當高考）」與
 * 「高考」兩種考試。我們的 session 欄位形式上標「第一次/第二次」，但其實
 * 100-1 / 101-1 是特考，100-2 / 101-2 是高考。
 *
 * 102 年起特考廢止（102/7/3 截止），只剩高考；標籤統一。
 *
 * 此 helper 依 exam_type 欄位產生語意正確的標籤：
 *   exam_type === 'special_high' → "100年特考"
 *   其他                          → "100年第一次"
 */
export function formatYearSession(q) {
  if (!q?.roc_year) return ''
  const year = q.roc_year
  if (q.exam_type === 'special_high') return `${year}年特考`
  if (q.session) return `${year}年${q.session}`
  return `${year}年`
}
