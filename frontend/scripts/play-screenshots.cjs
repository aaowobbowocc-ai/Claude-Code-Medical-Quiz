#!/usr/bin/env node
/**
 * Play Store 截圖腳本 — 自動產 5 張 1080×1920 (9:16) 手機螢幕截圖。
 *
 * 用法：
 *   cd frontend
 *   npm install --save-dev playwright
 *   npx playwright install chromium
 *   node scripts/play-screenshots.cjs
 *
 * 輸出：frontend/public/play-assets/screenshots/01-home.png 等 5 張
 *
 * Play Console 規格：
 *   - 至少 4 張 (要 promotional eligibility)
 *   - 9:16 直立 or 16:9 橫向
 *   - 每邊 320-3840 px
 *   - 1080×1920 是手機標準尺寸,Play Store 顯示效果最佳
 */
const { chromium, devices } = require('playwright')
const fs = require('fs')
const path = require('path')

const BASE_URL = process.env.SCREENSHOT_URL || 'https://examking.tw'
const OUT_DIR = path.join(__dirname, '..', 'public', 'play-assets', 'screenshots')

const VIEWPORT = { width: 1080, height: 1920 }
const DEVICE_SCALE = 1  // 1080×1920 已是物理像素

// 要截的頁面 + 截圖前要做的動作
const SCREENS = [
  {
    name: '01-home',
    url: '/',
    desc: '首頁 — 主畫面 + 國考類別',
    wait: 2500,
  },
  {
    name: '02-exam-list',
    url: '/?openExamPicker=1',
    desc: '考試選擇器',
    wait: 2000,
    // 如果 URL 不支援這 query,腳本會直接 fallback 截 / 然後手動 click
  },
  {
    name: '03-leaderboard',
    url: '/leaderboard',
    desc: '排行榜',
    wait: 2500,
  },
  {
    name: '04-sponsors',
    url: '/sponsors',
    desc: '感謝榜',
    wait: 2500,
  },
  {
    name: '05-coverage',
    url: '/coverage',
    desc: '題庫覆蓋率',
    wait: 2500,
  },
]

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE,
    // 模擬手機 user agent,避免被當桌機渲染
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.100 Mobile Safari/537.36',
    isMobile: true,
    hasTouch: true,
  })

  for (const s of SCREENS) {
    console.log(`[shoot] ${s.name} → ${BASE_URL}${s.url}`)
    const page = await context.newPage()
    await page.goto(BASE_URL + s.url, { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(s.wait)

    // 把可能彈出的安裝 App 引導 banner 關掉 (避免遮畫面)
    await page.evaluate(() => {
      const banners = document.querySelectorAll('[class*="install"], [class*="banner"]')
      banners.forEach((b) => {
        const txt = (b.textContent || '').slice(0, 30)
        if (txt.includes('安裝') || txt.includes('Install')) b.style.display = 'none'
      })
    }).catch(() => {})

    const outPath = path.join(OUT_DIR, `${s.name}.png`)
    await page.screenshot({ path: outPath, type: 'png', fullPage: false })
    console.log(`  ✓ ${outPath}`)
    await page.close()
  }

  await browser.close()
  console.log(`\n總共產出 ${SCREENS.length} 張: ${OUT_DIR}`)
  console.log('上 Play Console 時把這 5 張一起傳「手機螢幕截圖」即可。')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
