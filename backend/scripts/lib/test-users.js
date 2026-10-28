/*
 * 自己測試用的帳號 —— 收支相關的統計一律排除。
 *
 * 為什麼要有這個檔：本來 finance-report.js 與 audit-jkos-pending.js
 * 各自寫一份清單，多一個測試帳號就要記得兩邊都改，遲早漏掉。
 *
 * 要再加的話，優先加在這裡（程式內建、本機與 Oracle 都生效）；
 * 臨時要加也可以用環境變數 FINANCE_TEST_USER_IDS=uuid1,uuid2。
 */
const BUILT_IN = [
  // 開發者本人（暱稱 AAO，2026-04-13 建立）
  '0e727540-2fae-499a-bca2-3218cecc3600',

  // 2026-09-09 測購買流程用的兩個匿名帳號。暱稱都是「池6」、同一天建立、
  // 相隔兩分鐘各買一筆 coins_2500，然後**當天全額退款**
  //   GPA.3320-1486-3739-86845 / GPA.3379-9152-1444-99841
  // Play 的 earnings_202609 報表有這兩筆的 Charge refund / Full。
  // 使用者 2026-10-28 確認是自己測試用過的帳號。
  'af7fcb0c-6d6b-4870-a50f-d404d5228186',
  '564afed8-296f-4aad-9be8-7acf17bc5f4b',
]

function testUserIds() {
  return new Set([
    ...BUILT_IN,
    ...String(process.env.FINANCE_TEST_USER_IDS || '')
      .split(',').map(s => s.trim()).filter(Boolean),
  ])
}

module.exports = { testUserIds, BUILT_IN }
