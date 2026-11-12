#!/usr/bin/env node
/**
 * 補郵局卷「題幹提到圖／表卻沒有圖」的題（目前全在外勤的臺灣自然及人文地理）。
 *
 * 郵局卷是一頁兩大欄，圖與表**排在該欄選項的右邊**：
 *
 *   x 20 y697  【1】50.【圖50】為臺灣四周離島的分布圖，其中「戊」島的居民…   ← 題幹橫跨整欄
 *   x 35 y718  漢人            圖 x341 y714 w113 h98      ← 圖在選項右邊
 *   x 35 y741  達悟族
 *   x 35 y764  卑南族          x504 y781 「【圖50】」      ← 圖說
 *
 * 所以「題幹與第一個選項之間的空白帶」那套（extract-missing-figures.js）抓不到，
 * 「題幹指名方位」那套（extract-side-figures.js）也不適用 —— 題幹沒說左右。
 *
 * 判準：本題題錨到**同欄下一個題錨**之間，取「離欄位左緣 300pt 以外」的東西：
 *   · 嵌入圖塊（照片、分布圖）
 *   · 短文字行（表格的欄名與儲存格、圖說【圖50】）—— 表是用文字排的，沒有圖塊
 * 題幹與選項都從欄位左緣起排，所以不會被框進來。
 *
 * PDF 走 pdf-fetcher 既有快取，不連外網。
 *
 *   node scripts/extract-post-figures.js
 *   node scripts/extract-post-figures.js --apply
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { needsImage } = require('./lib/image-ref');

const BK = path.join(__dirname, '..');
const TMP = path.join(BK, '_tmp');
const IMG = path.join(BK, '..', 'frontend', 'public', 'question-images');
const APPLY = process.argv.includes('--apply');
const md5 = u => crypto.createHash('md5').update(u).digest('hex');

const ANCHOR = /^【\s*([^】]{1,40})\s*】\s*(\d{1,3})\s*[.．、]/;
const SIDE_GAP = 300;        // 離欄位左緣多遠才算「排在選項右邊」
const SCALE = 2;

function jobs() {
  const off = JSON.parse(fs.readFileSync(path.join(TMP, '_post-official-index.json'), 'utf8'));
  const out = [];
  for (const p of off.papers || []) {
    if (!p.isMcqPaper) continue;
    const s = p.subject || '', c = p.category || '';
    if (p.rank === '專業職二外勤' && /郵遞業務/.test(c)) {
      if (/臺灣自然/.test(s)) out.push({ exam: 'post-outdoor', tag: 'post_geo', year: p.year, url: p.url });
      if (/郵政法規/.test(s)) out.push({ exam: 'post-outdoor', tag: 'post_law', year: p.year, url: p.url });
    }
    if (p.rank === '專業職二內勤' && /櫃台業務/.test(c)) {
      if (/企業管理/.test(s)) out.push({ exam: 'post-indoor', tag: 'post_mgmt', year: p.year, url: p.url });
      if (/郵政三法/.test(s)) out.push({ exam: 'post-indoor', tag: 'post_law', year: p.year, url: p.url });
    }
  }
  return out;
}

(async () => {
  const sharp = require('sharp');
  const mupdf = await import('mupdf');
  const banks = {};
  for (const e of ['post-indoor', 'post-outdoor'])
    banks[e] = JSON.parse(fs.readFileSync(path.join(BK, `questions-${e}.json`), 'utf8'));

  let made = 0, skip = 0;
  const why = {};
  const bump = k => { why[k] = (why[k] || 0) + 1; skip++; };
  const touched = new Set();

  for (const j of jobs()) {
    const arr = banks[j.exam].questions;
    const targets = arr.filter(q => q.roc_year === j.year && q.subject_tag === j.tag
      && !(q.images && q.images.length) && !q.image_url && !q.no_image_in_source && needsImage(q));
    if (!targets.length) continue;
    const fp = path.join(TMP, 'post-official-cache', md5(j.url) + '.pdf');
    if (!fs.existsSync(fp)) { targets.forEach(() => bump('快取沒有這份 PDF')); continue; }
    const doc = mupdf.Document.openDocument(new Uint8Array(fs.readFileSync(fp)), 'application/pdf');

    // 逐頁收行與圖塊
    const pages = [];
    for (let pg = 0; pg < doc.countPages(); pg++) {
      const page = doc.loadPage(pg);
      const bnd = page.getBounds();
      const si = JSON.parse(page.toStructuredText('preserve-images').asJSON());
      const area = (bnd && bnd.length === 4) ? Math.abs((bnd[2] - bnd[0]) * (bnd[3] - bnd[1])) : 0;
      const blocks = (si.blocks || []).filter(b => b.type && b.type !== 'text' && b.bbox
        && b.bbox.w >= 30 && b.bbox.h >= 20);
      const scanned = area > 0 && blocks.some(b => b.bbox.w * b.bbox.h > area * 0.6);
      const figs = scanned ? [] : blocks.map(b => ({ x: b.bbox.x, y: b.bbox.y, w: b.bbox.w, h: b.bbox.h }));
      const lines = [];
      for (const b of (si.blocks || [])) {
        if (b.type !== 'text') continue;
        for (const l of (b.lines || [])) {
          const t = (l.text || '').normalize('NFC');
          if (t.trim()) lines.push({ x: l.bbox.x, y: l.bbox.y, w: l.bbox.w, h: l.bbox.h, t: t.trim() });
        }
      }
      lines.sort((a, b) => a.y - b.y || a.x - b.x);
      pages.push({ lines, figs, width: bnd ? bnd[2] - bnd[0] : 1191 });
    }

    // 大欄分界：題錨 x 的最大間隙（與 lib/post-parser.js 同一套判斷）
    const anchors = [];
    pages.forEach((pp, pg) => pp.lines.forEach(l => {
      const m = ANCHOR.exec(l.t);
      if (m) anchors.push({ pg, x: l.x, y: l.y, n: +m[2] });
    }));
    if (!anchors.length) { targets.forEach(() => bump('PDF 裡找不到題錨')); continue; }
    const axs = [...new Set(anchors.map(a => Math.round(a.x)))].sort((a, b) => a - b);
    let split = Infinity;
    for (let i = 1; i < axs.length; i++) if (axs[i] - axs[i - 1] > 150) { split = axs[i] - 60; break; }
    const colOf = x => (x < split ? 0 : 1);
    const colLeft = col => (col === 0 ? Math.min(...axs.filter(x => x < split))
      : Math.min(...axs.filter(x => x >= split)));

    for (const q of targets) {
      const a = anchors.find(x => x.n === +q.number);
      if (!a) { bump('定位不到題號'); continue; }
      const col = colOf(a.x);
      const pp = pages[a.pg];
      const next = anchors.filter(x => x.pg === a.pg && colOf(x.x) === col && x.y > a.y + 4)
        .sort((x, y) => x.y - y.y)[0];
      const yTop = a.y - 2, yBot = next ? next.y - 4 : 1e9;
      const minX = colLeft(col) + SIDE_GAP;
      const right = col === 0 ? split - 10 : pp.width - 10;

      /*
       * 選項不能框進來。郵局卷的選項標記是字型私用區的 U+F081~U+F084
       * （畫面上看起來是 ①②③④），而且**四個選項會橫排成一列**：
       *   x616 ①甲乙   x747 ②甲丙   x864 ③乙丁   x987 ④丙丁   圖 x1038
       * 不擋的話外勤 114 地理 #27 裁出來的圖左邊會印著三個選項，等於把答案
       * 一起放進圖裡。認「開頭是選項標記」最準 —— 它們比表格儲存格還短，
       * 靠寬度分不出來。
       */
      const isOption = t => /^[\u0080-\u009f-①-⑳Ⓐ-Ⓓ]|^[（(]?[A-EＡ-Ｅ][）).、]/.test(t);

      const boxes = [];
      for (const g of pp.figs)
        if (g.y >= yTop && g.y + g.h <= yBot + 4 && g.x >= minX && g.x < right)
          boxes.push({ x: g.x, y: g.y, w: g.w, h: g.h });
      for (const l of pp.lines)
        if (l.y >= yTop && l.y <= yBot && l.x >= minX && l.x < right && !isOption(l.t))
          boxes.push({ x: l.x, y: l.y, w: l.w, h: l.h });
      if (!boxes.length) { bump('選項右邊沒有圖也沒有表'); continue; }

      let x0 = Math.min(...boxes.map(b => b.x)), x1 = Math.max(...boxes.map(b => b.x + b.w));
      const y0 = Math.min(...boxes.map(b => b.y)), y1 = Math.max(...boxes.map(b => b.y + b.h));
      /*
       * 300pt 這條線是用來擋題幹與選項的，但表格常常從更左邊就開始排 ——
       * 外勤 112 地理 #37 的表左邊兩欄（農產品名稱、進口比率占第一位之國家）
       * 就落在線外，裁出來只剩右半張、看不出每一列是什麼。
       * 所以框出來之後再往左長：同一組 y 範圍內、緊貼著框左緣的**短行**（表格儲存格）
       * 併進來，直到碰不到為止。選項與題幹是從欄位左緣起排的長行，不會被收進來。
       */
      // 一次收齊：同一個 y 範圍內、比框更左但還在欄位內的**短行**都是表格儲存格。
      // 「一格一格往左長」行不通 —— 欄與欄之間有 57pt 的空白（儲存格置中排版），
      // 只要門檻設得保守就會停在第二欄（112 地理 #37 的前兩欄還是被切掉）。
      // 題幹與選項是從欄位左緣起排的長行（w > 140），不會被收進來。
      const cellMin = colLeft(col) + 60;
      const cells = pp.lines.filter(l => l.y >= y0 - 4 && l.y + (l.h || 12) <= y1 + 4
        && l.x >= cellMin && l.x < x0 && l.w <= 140 && !isOption(l.t));
      if (cells.length) x0 = Math.min(x0, ...cells.map(l => l.x));
      if (x1 - x0 < 50 || y1 - y0 < 40) { bump('右邊那塊太小(多半是頁碼或單一標記)') ; continue; }

      const name = `${j.exam}_${q.exam_code.replace('post-', '')}_${j.tag.replace('post_', '')}_q${q.number}_fig.webp`;
      console.log(`${APPLY ? '✓' : '·'} ${j.exam} ${j.year} ${j.tag} #${q.number}  p${a.pg} 欄${col}` +
        `  x${Math.round(x0)}-${Math.round(x1)} y${Math.round(y0)}-${Math.round(y1)}  (${boxes.length} 塊)`);
      if (!APPLY) { made++; continue; }
      try {
        const page = doc.loadPage(a.pg);
        const pm = page.toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceRGB, false, true);
        const png = Buffer.from(pm.asPNG());
        const meta = await sharp(png).metadata();
        const L = Math.max(0, Math.round(x0 * SCALE) - 8);
        const T = Math.max(0, Math.round(y0 * SCALE) - 8);
        const W = Math.min(meta.width - L, Math.round((x1 - x0) * SCALE) + 16);
        const H = Math.min(meta.height - T, Math.round((y1 - y0) * SCALE) + 16);
        // sharp 0.34：extract 與 trim 不能串在同一條 pipeline
        const buf = await sharp(png).extract({ left: L, top: T, width: W, height: H }).png().toBuffer();
        const stats = await sharp(buf).stats();
        if (!stats.channels.some(c => c.min < 200)) { bump('裁出來是空白'); continue; }
        let out = sharp(buf);
        try { out = sharp(await sharp(buf).trim({ threshold: 12 }).toBuffer()); } catch { out = sharp(buf); }
        await out.webp({ quality: 88 }).toFile(path.join(IMG, name));
        q.images = [`/question-images/${name}`];
        /*
         * 圖補上了，missing_image 這個理由就不成立 —— 但**不能無條件放出來**。
         * 內勤 111 企管 #2 原本標 missing_image，補上表之後一放出來，
         * 它那組爛掉的選項（A=" A"、B=整列表頭、C=" B"、D="A"）就變成
         * 使用者看得到的「選項重複」。補圖不等於修好這一題。
         * 所以放出來之前先驗選項：有空格、有重複的就改標 broken_options 繼續隱藏。
         */
        if (q.incomplete === 'missing_image') {
          const vals = ['A', 'B', 'C', 'D'].map(k => String((q.options || {})[k] == null ? '' : q.options[k]).replace(/\s+/g, ''));
          const sane = vals.every(Boolean) && new Set(vals).size === 4;
          if (sane) delete q.incomplete; else q.incomplete = 'broken_options';
        }
        touched.add(j.exam);
        made++;
      } catch (e) { bump('裁圖失敗: ' + String(e.message).slice(0, 26)); }
    }
  }

  if (APPLY) for (const e of touched) {
    fs.writeFileSync(path.join(BK, `questions-${e}.json`), JSON.stringify(banks[e], null, 2), 'utf8');
    console.log(`✅ → questions-${e}.json`);
  }
  console.log(`\n${APPLY ? '已產生' : '可產生'} ${made} 張圖｜跳過 ${skip}`);
  if (Object.keys(why).length) console.log('跳過原因:', JSON.stringify(why, null, 1));
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})().catch(e => { console.error(e.stack); process.exit(1); });
