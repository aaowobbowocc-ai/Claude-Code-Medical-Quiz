#!/usr/bin/env node
/**
 * Play Store 截圖腳本 — 真實手機/平板尺寸自動截圖。
 *
 * 改版重點：改用 Playwright 內建 device preset，產出真實手機/平板比例
 * (Pixel 7 = 20:9 修長,iPad mini = 4:3)。比死板 1080×1920 (16:9) 更像
 * 真機 screenshot,Play Store 審核員/使用者看了不會懷疑是假的。
 *
 * 用法：
 *   cd frontend
 *   node scripts/play-screenshots.cjs
 *   node scripts/play-screenshots.cjs --tablet     # 改截平板尺寸
 *
 * 輸出：
 *   public/play-assets/screenshots/         (手機)
 *   public/play-assets/screenshots-tablet/  (平板,加 --tablet 時產出)
 *
 * Play Console 規格：
 *   - 手機: 每邊 320-3840 px,Pixel 7 螢幕 1080×2400 完美符合
 *   - 7 吋平板: 每邊 320-3840,iPad mini 1536×2048 符合
 *   - 10 吋平板: 每邊 1080-7680,iPad Pro 11" 1668×2388 符合
 */
const { chromium, devices } = require('playwright')
const fs = require('fs')
const path = require('path')

const BASE_URL = process.env.SCREENSHOT_URL || 'https://examking.tw'
const TABLET_MODE = process.argv.includes('--tablet')

const OUT_DIR = path.join(
  __dirname, '..', 'public', 'play-assets',
  TABLET_MODE ? 'screenshots-tablet' : 'screenshots'
)

// 手機: Pixel 7 直立 (412×915 viewport, DPR 2.625 → 截圖 1082×2202)
// 平板: iPad (Gen 7) 橫向 (1080×810 viewport, DPR 2 → 截圖 2160×1620)
//   橫向 1024+ 觸發 lg breakpoint,phone-frame 拓到 960px,
//   Home 卡片 lg:grid-cols-4/5,內容鋪滿不再留大片空白。
const DEVICE = TABLET_MODE ? devices['iPad (gen 7) landscape'] : devices['Pixel 7']
console.log(`[device] ${TABLET_MODE ? 'iPad landscape' : 'Pixel 7'}: viewport=${DEVICE.viewport.width}×${DEVICE.viewport.height}, DPR=${DEVICE.deviceScaleFactor}`)

const SCREENS = [
  // 首頁 splash 動畫 + registry 載入久,給 5 秒
  { name: '01-home',         url: '/',            wait: 5000 },
  { name: '02-leaderboard',  url: '/leaderboard', wait: 2500 },
  { name: '03-coverage',     url: '/coverage',    wait: 2500 },
  { name: '04-sponsors',     url: '/sponsors',    wait: 2500 },
  { name: '05-changelog',    url: '/changelog',   wait: 2500 },
]

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = await chromium.launch()
  const context = await browser.newContext({ ...DEVICE })

  for (const s of SCREENS) {
    console.log(`[shoot] ${s.name} → ${BASE_URL}${s.url}`)
    const page = await context.newPage()
    // dev server 用 'load' (networkidle 因 HMR 永遠不靜止),正式網站用 networkidle
    const waitUntil = BASE_URL.includes('localhost') ? 'load' : 'networkidle'
    await page.goto(BASE_URL + s.url, { waitUntil, timeout: 30000 })
    await page.waitForTimeout(s.wait)

    // 關掉所有 sticky / fixed 底部 toast (贊助卡 / 安裝 banner 等)
    await page.evaluate(() => {
      document.querySelectorAll('div').forEach((b) => {
        const cls = b.className || ''
        const style = window.getComputedStyle(b)
        // 抓 fixed bottom-0 / sticky bottom 元素
        if (typeof cls === 'string' && /\bfixed\b/.test(cls) && /\bbottom-0\b/.test(cls)) {
          b.style.display = 'none'
        }
      })
      // 補抓 SupportSheets 觸發按鈕 / 安裝 banner
      document.querySelectorAll('[class*="install"], [class*="pwa"]').forEach((b) => {
        const txt = (b.textContent || '').slice(0, 40)
        if (/安裝|Install/.test(txt)) b.style.display = 'none'
      })
    }).catch(() => {})

    // 再等一下,確保隱藏完成 + layout reflow
    await page.waitForTimeout(500)

    const outPath = path.join(OUT_DIR, `${s.name}.png`)
    await page.screenshot({ path: outPath, type: 'png', fullPage: false })
    const stat = fs.statSync(outPath)
    console.log(`  ✓ ${outPath} (${(stat.size / 1024).toFixed(0)} KB)`)
    await page.close()
  }

  await browser.close()
  console.log(`\n${SCREENS.length} 張截圖已存到: ${OUT_DIR}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
