#!/usr/bin/env node
/**
 * 補教檢（教師資格考試）「題幹提到圖卻沒有圖」的題。
 *
 * 教檢的試題 PDF 不在考選部，而是 tqa.rcpet.edu.tw 的 ASP.NET postback 後面，
 * 所以 extract-missing-figures.js 那套（走 resolvePaper）對教檢一律回報
 * 「可產生 0 張、跳過 0」——看起來像沒有候選，其實是連卷都拿不到。
 * 這支借 scrape-teacher.js 的 fetchListing 拿同一份 PDF，不另外抄一份流程。
 *
 * 版面是單欄，圖排在題幹與第一個選項之間，所以定位方式跟考選部一般卷一樣：
 *   1. 題號行「11.」
 *   2. 第一個選項行「(A)」
 *   3. 中間的嵌入圖片區塊；沒有圖片區塊就退回「沒有文字的空白帶」（向量圖）
 *
 *   node scripts/extract-teacher-figures.js [--exam=teacher-kindergarten] [--apply]
 */
const fs = require('fs');
const path = require('path');
const { fetchListing, request, EXAMS, SUBJECTS, PAGE } = require('./scrape-teacher');
const { needsImage } = require('./lib/image-ref');

const BK = path.join(__dirname, '..');
const IMG = path.join(BK, '..', 'frontend', 'public', 'question-images');
const APPLY = process.argv.includes('--apply');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];
const OPTLINE = /^[（(]\s*[A-DＡ-Ｄ]\s*[）)]/;

(async () => {
  const sharp = require('sharp');
  const mupdf = await import('mupdf');
  let made = 0;
  const why = {};
  const bump = k => { why[k] = (why[k] || 0) + 1; };

  for (const examId of Object.keys(EXAMS)) {
    if (only && examId !== only) continue;
    const f = `questions-${examId}.json`;
    if (!fs.existsSync(path.join(BK, f))) continue;
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    if (!arr) continue;
    const targets = arr.filter(q => !q.no_image_in_source && !q.incomplete
      && !(q.images && q.images.length) && !q.image_url && !q.image && !q.option_images
      && needsImage(q));
    if (!targets.length) continue;

    // 依年份分組：一個年份只要抓一次 listing
    const byYear = {};
    for (const q of targets) {
      const y = String(q.roc_year || q.exam_code).replace(/[^0-9]/g, '');
      (byYear[y] = byYear[y] || []).push(q);
    }
    let touched = false;

    for (const year of Object.keys(byYear)) {
      let listing;
      try { listing = await fetchListing(year, EXAMS[examId]); }
      catch (e) { byYear[year].forEach(() => bump('拿不到該年度的卷: ' + String(e.message).slice(0, 30))); continue; }

      for (const q of byYear[year]) {
        const subj = SUBJECTS.find(s => s.name === q.subject);
        const item = subj && listing.find(x => x.subject.name === subj.name);
        if (!item) { bump('對不到科目'); continue; }
        let doc;
        try {
          const r = await request('GET', item.qPdf, { headers: { Cookie: item.cookie, Referer: PAGE } });
          if (r.status !== 200) throw new Error('HTTP ' + r.status);
          doc = mupdf.Document.openDocument(new Uint8Array(r.body), 'application/pdf');
        } catch (e) { bump('下載／開啟失敗: ' + String(e.message).slice(0, 24)); continue; }

        // 收題號、選項、圖塊
        const heads = [], opts = [], figs = [], lines = [];
        for (let pg = 0; pg < doc.countPages(); pg++) {
          const page = doc.loadPage(pg);
          try {
            const si = JSON.parse(page.toStructuredText('preserve-images').asJSON());
            const bnd = page.getBounds();
            const area = Math.abs((bnd[2] - bnd[0]) * (bnd[3] - bnd[1]));
            const bs = (si.blocks || []).filter(b => b.type && b.type !== 'text' && b.bbox
              && b.bbox.w >= 40 && b.bbox.h >= 25);
            if (!bs.some(b => b.bbox.w * b.bbox.h > area * 0.6)) {
              for (const b of bs) figs.push({ pg, x: b.bbox.x, y: b.bbox.y, w: b.bbox.w, h: b.bbox.h });
            }
          } catch { /* 這頁抽不到圖塊 */ }
          const st = JSON.parse(page.toStructuredText('preserve-whitespace').asJSON());
          for (const b of st.blocks || []) for (const l of b.lines || []) {
            const t = (l.text || '').normalize('NFC').trim();
            if (!t) continue;
            const row = { pg, x: l.bbox.x, y: l.bbox.y, h: l.bbox.h, t };
            lines.push(row);
            const m = /^(\d{1,3})\s*[.．、]/.exec(t);
            if (m && l.bbox.x < 90) heads.push({ ...row, n: +m[1] });
            else if (OPTLINE.test(t)) opts.push(row);
          }
        }
        const head = heads.find(h => h.n === +q.number);
        if (!head) { bump('定位不到題號'); continue; }
        const firstOpt = opts.find(o => o.pg === head.pg && o.y > head.y);
        if (!firstOpt) { bump('找不到第一個選項'); continue; }

        const inBand = figs.filter(g => g.pg === head.pg && g.y >= head.y - 2 && g.y + g.h <= firstOpt.y + 2);
        let band = null;
        if (inBand.length) {
          const top = Math.min(...inBand.map(g => g.y));
          const bot = Math.max(...inBand.map(g => g.y + g.h));
          band = { top, h: bot - top };
        } else {
          // 向量圖：找題幹與選項之間最大的一段空白
          const between = lines.filter(l => l.pg === head.pg && l.y > head.y && l.y < firstOpt.y)
            .sort((a, b) => a.y - b.y);
          let prevBottom = head.y + (head.h || 12);
          for (const l of between) {
            if (l.y - prevBottom >= 40 && (!band || l.y - prevBottom > band.h)) band = { top: prevBottom, h: l.y - prevBottom };
            prevBottom = Math.max(prevBottom, l.y + (l.h || 12));
          }
          if (firstOpt.y - prevBottom >= 40 && (!band || firstOpt.y - prevBottom > band.h)) {
            band = { top: prevBottom, h: firstOpt.y - prevBottom };
          }
        }
        if (!band) { bump('題幹與選項間沒有空白帶(應無圖)'); continue; }

        const name = `${examId}_${year}_${subj.id}_q${q.number}_fig.webp`;
        console.log(`${APPLY ? '✓' : '·'} ${examId} ${year} ${q.subject} #${q.number}`
          + ` p${head.pg} y${Math.round(band.top)}+${Math.round(band.h)} ${inBand.length ? '嵌圖' : '空白帶'}`);
        if (APPLY) {
          try {
            const page = doc.loadPage(head.pg);
            const pm = page.toPixmap(mupdf.Matrix.scale(3, 3), mupdf.ColorSpace.DeviceRGB, false, true);
            const png = Buffer.from(pm.asPNG());
            const meta = await sharp(png).metadata();
            const T = Math.max(0, Math.round(band.top * 3) - 9);
            const H = Math.min(meta.height - T, Math.round(band.h * 3) + 18);
            if (H < 90) { bump('裁出來太小'); continue; }
            const buf = await sharp(png).extract({ left: 0, top: T, width: meta.width, height: H }).png().toBuffer();
            const st2 = await sharp(buf).stats();
            if (!st2.channels.some(c => c.min < 200)) { bump('該區塊是空白(原卷沒圖)'); continue; }
            let out = buf;
            try { out = await sharp(buf).trim({ threshold: 12 }).toBuffer(); } catch (_) { /* 全白會拋 */ }
            await sharp(out).webp({ quality: 88 }).toFile(path.join(IMG, name));
            q.images = [`/question-images/${name}`];
            touched = true;
          } catch (e) { bump('裁圖失敗: ' + String(e.message).slice(0, 24)); continue; }
        }
        made++;
      }
    }
    if (APPLY && touched) fs.writeFileSync(path.join(BK, f), JSON.stringify(j, null, 2), 'utf8');
  }
  console.log(`${APPLY ? '已產生' : '可產生'} ${made} 張圖`);
  if (Object.keys(why).length) console.log('跳過原因:', JSON.stringify(why, null, 1));
})().catch(e => { console.error(e.stack); process.exit(1); });
