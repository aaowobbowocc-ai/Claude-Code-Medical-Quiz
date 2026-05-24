// 探查 medlab 殘留 11 題的 PDF 結構
const fs = require('fs')
const path = require('path')
const PDF_DIR = path.join(__dirname, '..', '_tmp', 'pdf-cache')

const TARGETS = [
  ['medlab_100140_c104_s0107.pdf', [2, 12, 24]],
  ['medlab_108030_c308_s11.pdf',   [16]],
  ['medlab_105020_c308_s66.pdf',   [5]],
  ['medlab_110100_c308_s66.pdf',   [4]],
  ['medlab_110020_c308_s66.pdf',   [10]],
  ['medlab_112020_c308_s22.pdf',   [24]],
  ['medlab_112020_c308_s33.pdf',   [56]],
  ['medlab_112100_c308_s22.pdf',   [30]],
  ['medlab_113020_c308_s22.pdf',   [40]],
]

async function main() {
  const mupdf = await import('mupdf')
  for (const [file, qnums] of TARGETS) {
    const doc = mupdf.Document.openDocument(new Uint8Array(fs.readFileSync(path.join(PDF_DIR, file))), 'application/pdf')
    console.log('\n══════ ' + file + ' ══════')
    // 收集每頁 qline + image
    const pages = []
    for (let p = 0; p < doc.countPages(); p++) {
      const st = JSON.parse(doc.loadPage(p).toStructuredText('preserve-images').asJSON())
      const blocks = st.blocks || []
      const qlines = [], lines = [], imgs = []
      for (const b of blocks) {
        if (b.type === 'image') { imgs.push({ y: Math.round(b.bbox.y), x: Math.round(b.bbox.x), w: Math.round(b.bbox.w), h: Math.round(b.bbox.h) }); continue }
        for (const l of (b.lines || [])) {
          const t = (l.text || '').trim()
          lines.push({ y: Math.round(l.bbox.y), x: Math.round(l.bbox.x), t })
          let m = t.match(/^(\d{1,3})\s*[.．、]/)
          if (!m && l.bbox.x < 68) m = t.match(/^(\d{1,3})$/)
          if (m) qlines.push({ n: +m[1], y: Math.round(l.bbox.y) })
        }
      }
      pages.push({ p, qlines, lines, imgs })
    }
    for (const qn of qnums) {
      // 找哪頁有此題號
      let pi = pages.findIndex(pg => pg.qlines.some(q => q.n === qn))
      console.log(`\n--- 第${qn}題 ---`)
      if (pi < 0) { console.log('  (題號未偵測到)'); continue }
      for (let p = pi; p <= Math.min(pi + 1, pages.length - 1); p++) {
        const pg = pages[p]
        console.log(`  p${p}: image塊=${pg.imgs.length} ${pg.imgs.map(i => `[y${i.y} ${i.w}x${i.h}]`).join(' ')}`)
        const qy = (pg.qlines.find(q => q.n === qn) || {}).y
        const nextY = Math.min(...pg.qlines.filter(q => q.n > qn).map(q => q.y), 9999)
        for (const l of pg.lines) {
          if (p === pi && (l.y < (qy || 0) - 4 || l.y > nextY + 4)) continue
          if (p > pi && l.y > 300) continue
          console.log(`    y${l.y} x${l.x}  ${l.t.slice(0, 44)}`)
        }
      }
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
