#!/usr/bin/env node
/**
 * 補「需要看圖卻沒圖」的題：從考選部試題 PDF 的該題區域裁圖。
 *
 * 判定用 lib/image-ref.js（單一來源，不要再自己寫 regex——盤點與補圖用不同
 * regex 曾造成「盤點說缺 75 題、補圖工具卻回報 0 個候選」）。
 *
 * 作法：用選項標記定位該題的 y 範圍，把該範圍內的頁面區塊轉成點陣圖裁下來。
 * 只裁「題幹與第一個選項之間」——圖一定在那裡；裁到選項會把答案一起截進去。
 *
 *   node scripts/extract-missing-figures.js [--exam rt] [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { needsImage } = require('./lib/image-ref');

const BK = path.join(__dirname, '..');
const IMG = path.join(BK, '..', 'frontend', 'public', 'question-images');
const APPLY = process.argv.includes('--apply');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];
const MARK = { '': 'A', '': 'B', '': 'C', '': 'D' };

(async () => {
  const sharp = require('sharp');
  const mupdf = await import('mupdf');
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f));
  let made = 0, skip = 0, errs = 0;
  const why = {};
  for (const f of files) {
    const exam = f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '');
    if (only && exam !== only) continue;
    // 學測／分科不是考選部的卷，resolvePaper 一定找不到（會灌水成 237 筆「對不到官方卷」）。
    // 它們走 extract-ceec-figures.js。
    if (exam === 'gsat' || exam === 'ast') continue;
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions; if (!arr) continue;
    // 候選不再只看題幹文字。needsImage() 的 regex 漏掉第三種寫法了：
    //   rt 111100 #63「下列肺功能測量之流速體積曲線圖，何者顯示阻塞性通氣障礙？」
    //   —— 「下列」後面接的是「肺」不是「圖」，整串 token 一個都沒中
    //   （2026-11-02 使用者回報「題目中說有圖片，但是畫面沒有顯示出來」）。
    // 試過把 regex 加寬成「下列…圖，」，全站新增 23 筆**多半是誤報**
    //   （「編製的藍圖」是比喻、「下列何種狀況會影響病人之心電圖」不需要圖）；
    // 也試過「選項全是圈號①②③④」，6,483 筆，圈號其實指題幹裡列的項目。
    // 所以不加寬文字判準，改用直接證據：**原卷在題幹與第一個選項之間
    // 真的有一塊嵌入圖片**。下面 byImage 那條路就是這樣判的。
    const targets = arr.filter(q => !(q.images && q.images.length) && !q.image_url && !q.option_images
      && !q.no_image_in_source && !q.incomplete);
    if (!targets.length) continue;
    const groups = {};
    for (const q of targets) { const k = q.exam_code + '|' + q.subject; (groups[k] = groups[k] || []).push(q); }
    let touched = false;
    for (const k of Object.keys(groups)) {
      const [code, ...rest] = k.split('|'); const subject = rest.join('|');
      const items = arr.filter(q => q.exam_code === code && q.subject === subject);
      let doc, p;
      try {
        p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items });
        if (!p) { why['對不到官方卷'] = (why['對不到官方卷'] || 0) + groups[k].length; continue; }
        doc = mupdf.Document.openDocument(await fetchSheet('Q', code, p.c, p.s), 'application/pdf');
      } catch (e) { errs++; continue; }
      // 逐頁收行，記下每個題號與每個選項標記的位置
      const marks = [];
      // 嵌入圖片區塊。'preserve-images' 才會吐 type!=='text' 的 block。
      // 掃描檔要擋掉：整頁就是一張圖的話，每一題都會「有圖」。
      const figs = [];
      for (let pg = 0; pg < doc.countPages(); pg++) {
        try {
          const pageObj = doc.loadPage(pg);
          const si = JSON.parse(pageObj.toStructuredText('preserve-images').asJSON());
          // 頁面尺寸要從 getBounds() 拿。StructuredText 的 JSON **沒有 bbox 欄位**，
          // 本來寫 si.bbox 導致 pageArea 退成 1，於是每一頁都被判成掃描檔、
          // 圖片區塊整批被丟掉（找了一輪才發現是 fail-closed）。
          const bnd = pageObj.getBounds();           // [x0,y0,x1,y1]
          const pageArea = (bnd && bnd.length === 4) ? Math.abs((bnd[2] - bnd[0]) * (bnd[3] - bnd[1])) : 0;
          const blocks = (si.blocks || []).filter(b => b.type && b.type !== 'text' && b.bbox);
          // 掃描檔要擋掉，但尺寸拿不到時**不要**擋 —— 寧可多裁一張也不要整批靜默消失
          const scanned = pageArea > 0 && blocks.some(b => (b.bbox.w * b.bbox.h) > pageArea * 0.6);
          if (!scanned) for (const b of blocks) {
            if (b.bbox.w < 40 || b.bbox.h < 25) continue;        // 小圖示／印章
            figs.push({ pg, y: b.bbox.y, x: b.bbox.x, w: b.bbox.w, h: b.bbox.h });
          }
        } catch { /* 這一頁抽不出圖，照舊走空白帶 */ }
        const st = JSON.parse(doc.loadPage(pg).toStructuredText('preserve-whitespace').asJSON());
        for (const b of st.blocks || []) for (const l of b.lines || []) {
          const t = (l.text || '').normalize('NFC'); if (!t.trim()) continue;
          // 題號有兩種排法：獨立一行的「12」（公職卷），以及「9.」後面直接接題幹（醫事類）。
          // 只認前者會讓醫事類整批「定位不到題號」（實測 89 題）。
          const num = /^(\d{1,3})\s*$/.exec(t.trim()) || /^(\d{1,3})\s*[.、]/.exec(t.trim());
          if (num) marks.push({ pg, y: l.bbox.y, h: l.bbox.h, kind: 'num', n: +num[1], x: l.bbox.x });
          // 選項標記同樣有兩種：PUA 的 ⒶⒷⒸⒹ，與醫事類明示的「A.」
          else if (MARK[t[0]] || /^[A-D]\s*[.、]/.test(t.trim())) marks.push({ pg, y: l.bbox.y, h: l.bbox.h, kind: 'opt' });
          else marks.push({ pg, y: l.bbox.y, h: l.bbox.h, kind: 'text' });
        }
      }
      for (const q of groups[k]) {
        const n = +q.number;
        const head = marks.find(m => m.kind === 'num' && m.n === n && m.x < 90);
        if (!head) { skip++; why['定位不到題號'] = (why['定位不到題號'] || 0) + 1; continue; }
        const firstOpt = marks.find(m => m.kind === 'opt' && m.pg === head.pg && m.y > head.y);
        if (!firstOpt) { skip++; why['找不到第一個選項'] = (why['找不到第一個選項'] || 0) + 1; continue; }
        // 圖在「題幹與選項之間、沒有任何文字行的那一段空白」。
        // 不能直接裁 head→firstOpt：長題幹會被整段框起來變成一張多餘的文字圖
        // （lawyer1 105110 #44 實測，那題根本沒有圖）。
        const between = marks.filter(m => m.pg === head.pg && m.y > head.y && m.y < firstOpt.y)
          .sort((a, b) => a.y - b.y);
        let band = null, prevBottom = head.y + (head.h || 12);
        for (const m of between) {
          if (m.y - prevBottom >= 40 && (!band || m.y - prevBottom > band.h)) band = { top: prevBottom, h: m.y - prevBottom };
          prevBottom = Math.max(prevBottom, m.y + (m.h || 12));
        }
        if (firstOpt.y - prevBottom >= 40 && (!band || firstOpt.y - prevBottom > band.h)) band = { top: prevBottom, h: firstOpt.y - prevBottom };

        // 直接證據優先：題幹與第一個選項之間真的有嵌入圖片，就照它的 bbox 裁。
        // 比空白帶準 —— 空白帶會把長題幹整段框起來變成一張多餘的文字圖
        // （lawyer1 105110 #44 實測，那題根本沒有圖）。
        const inBand = figs.filter(g => g.pg === head.pg
          && g.y >= head.y - 2 && g.y + g.h <= firstOpt.y + 2);
        let byImage = false;
        if (inBand.length) {
          const top = Math.min(...inBand.map(g => g.y));
          const bot = Math.max(...inBand.map(g => g.y + g.h));
          band = { top, h: bot - top };
          byImage = true;
        }
        // 沒有嵌入圖片時才退回空白帶，而且只在題幹文字真的提到圖的時候 ——
        // 考選部有很多圖是向量繪製的，不會變成 image block，那些只能靠空白帶。
        if (!byImage && !needsImage(q)) { skip++; why['題幹沒提到圖、原卷也沒有嵌入圖片'] = (why['題幹沒提到圖、原卷也沒有嵌入圖片'] || 0) + 1; continue; }
        if (!band) { skip++; why['題幹與選項間沒有空白帶(應無圖)'] = (why['題幹與選項間沒有空白帶(應無圖)'] || 0) + 1; continue; }
        const name = `${exam}_${code}_q${n}_fig.webp`;
        if (APPLY) {
          try {
            const page = doc.loadPage(head.pg);
            const pm = page.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true);
            const png = Buffer.from(pm.asPNG());
            const meta = await sharp(png).metadata();
            const top = Math.max(0, Math.round(band.top * 2) - 4);
            const bot = Math.min(meta.height, Math.round((band.top + band.h) * 2) + 4);
            if (bot - top < 40) { skip++; continue; }
            // 先平裁不 trim，再看統計。近乎全白的區塊直接 .trim() 會拋
            // 「extract_area: bad extract area」——看起來像座標算錯，其實是
            // trim 把整張都當邊框裁掉了（這個坑記在 memory 裡）。
            const base = sharp(png).extract({ left: 0, top, width: meta.width, height: bot - top });
            const buf = await base.png().toBuffer();
            const st2 = await sharp(buf).stats();
            const dark = st2.channels.some(c => c.min < 200);   // 有明顯深色 = 真的有圖
            if (!dark) { skip++; why['該區塊是空白(原卷本來就沒圖)'] = (why['該區塊是空白(原卷本來就沒圖)'] || 0) + 1; continue; }
            let out = sharp(buf);
            try { out = sharp(await sharp(buf).trim({ threshold: 12 }).toBuffer()); }
            catch (_) { out = sharp(buf); }                      // trim 失敗就用未裁邊的
            await out.webp({ quality: 88 }).toFile(path.join(IMG, name));
            q.images = [`/question-images/${name}`];
            touched = true;
          } catch (e) {
            skip++; const key = '裁圖失敗:' + String(e.message).slice(0, 30);
            why[key] = (why[key] || 0) + 1; continue;
          }
        }
        made++;
      }
    }
    if (APPLY && touched) fs.writeFileSync(path.join(BK, f), JSON.stringify(j, null, 2), 'utf8');
  }
  console.log(`${APPLY ? '已產生' : '可產生'} ${made} 張圖｜跳過 ${skip}${errs ? `｜⚠️ ${errs} 卷失敗` : ''}`);
  if (Object.keys(why).length) console.log('跳過原因:', JSON.stringify(why, null, 1));
})().catch(e => { console.error(e.stack); process.exit(1); });
