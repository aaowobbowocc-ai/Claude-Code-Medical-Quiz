#!/usr/bin/env node
/**
 * 修「同一行被 PDF 拆成好幾段，parser 只收了第一段」造成的題幹／選項被截斷。
 *
 * 有些考選部卷子的每一個**視覺行**在 PDF 裡是兩三個 text run：
 *
 *   x52  y296 "73.下圖為二種長度不同的輪椅扶手設計，"
 *   x243 y296 "下列敘述何者正確？"            ← 同一行的後半段
 *   x62  y435 "B.使用輪椅桌板時，將桌板架在甲扶手上"
 *   x238 y435 "上，相較於乙扶手，會有比較穩固的支撐"   ← 後半段，而且**重複一個字**
 *
 * parser 只收前半段，使用者看到的就是「題目不完整」
 *（2026-11-12 使用者回報 物理治療師 114 第一次 #73、111 第二次 #47）。
 *
 * 作法：把同一個 y（±4pt）的 run 依 x 黏回一行，黏的時候去掉重複的那一個字，
 * 再用 A./B./C./D. 行首切出題幹與四個選項，和題庫逐欄比對。
 *
 * 只在**確定是截斷**時才覆寫（寧可不動）：
 *   · 重建結果要剛好四個選項、皆非空、彼此相異
 *   · 題庫的那一欄必須是重建結果的「前綴」，或「前綴＋後綴」
 *     （中間那段掉了的也算，例：「…內側距離為 為三輪電動代步車」）
 *   · 題組題（題幹帶【題組情境】）一律跳過 —— 題幹是合併過的，比不了
 *
 *   node scripts/repair-line-merge-truncation.js [--exam=pt] [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];
const OPT = /^([A-D])\s*[.．、]\s*/;
const FURNITURE = /^(代號|頁次|編號)[：:]|^第\s*\d+\s*頁|請接續|^-\s*\d+\s*-$/;

const norm = s => String(s == null ? '' : s).normalize('NFC')
  .replace(/[\u0080-\u009f­​-‏-�]/g, '')
  .replace(/[\s　]+/g, '');

/** 同一行的 run 依 x 黏起來，去掉後段開頭重複的那一個字 */
function joinRuns(runs) {
  runs.sort((a, b) => a.x - b.x);
  let out = runs[0].t;
  let prevRight = runs[0].x + (runs[0].w || 0);
  for (let i = 1; i < runs.length; i++) {
    const a = out.replace(/\s+$/, '');
    const b = runs[i].t.replace(/^\s+/, '');
    // 兩段之間本來就有空白（前段結尾或後段開頭）→ 黏回去的時候要留著，
    // 不然英文會黏成一個字（developmental coordination＋disorder → coordinationdisorder）。
    const hadSpace = a.length !== out.length || b.length !== runs[i].t.length;
    if (a.length && b.length && a[a.length - 1] === b[0]) out = a + b.slice(1);
    // 沒有重複字、又離得遠 → 是表格的另一格，要留一個空白，
    // 不然「32 秒」會變成「32秒」、整列資料黏成一串（pt 115020 神經 #77）。
    else if (hadSpace || runs[i].x - prevRight > 10) out = a + ' ' + b;
    else out = a + b;
    prevRight = runs[i].x + (runs[i].w || 0);
  }
  return out;
}

/** 題庫的字串是不是「重建結果掉了中間一段」的樣子 */
function isTruncationOf(bankRaw, fullRaw) {
  const b = norm(bankRaw), f = norm(fullRaw);
  if (!b || !f || b === f || b.length >= f.length) return false;
  // 補回來的量要合理。題號沒被偵測到時，這一題的範圍會往下吃到下一題，
  // 最後一個選項就會被接上整段別題的文字 —— 那種「補」是災難，不是修復。
  if (f.length > b.length + 150) return false;
  // 補的那一段裡不能出現「12.…」這種題號，那代表框到下一題了
  if (/\d{1,3}[.．、][^\d]{10,}/.test(f.slice(Math.max(0, b.length - 4)))) return false;
  if (f.startsWith(b)) return 'prefix';                 // 純粹被截尾
  // 前綴＋後綴：找最長共同前綴，剩下的必須是 full 的結尾
  let i = 0;
  while (i < b.length && b[i] === f[i]) i++;
  if (i < 6) return false;
  const rest = b.slice(i);
  return (rest.length >= 2 && f.endsWith(rest)) ? 'split' : false;
}

/**
 * 只把「少掉的那一段」接回去，不要整欄覆寫。
 * 重建版的空白是用幾何推回來的，表格題（「32 秒」）會跟原本排得不一樣；
 * 既然前半段本來就對，就留著原本的，只接尾巴。
 */
function tailAfter(fullRaw, keepN) {
  let seen = 0;
  for (let i = 0; i < fullRaw.length; i++) {
    if (norm(fullRaw[i])) seen++;        // 空白與不可見字元不算數
    if (seen >= keepN) return fullRaw.slice(i + 1);
  }
  return '';
}

(async () => {
  const mupdf = await import('mupdf');
  let fixed = 0, papers = 0;
  const why = {};
  const bump = k => { why[k] = (why[k] || 0) + 1; };

  for (const f of fs.readdirSync(BK).filter(x => /^questions(-[a-z0-9-]*)?\.json$/.test(x))) {
    const exam = f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '');
    if (only && exam !== only) continue;
    if (exam === 'gsat' || exam === 'ast') continue;
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    if (!arr) continue;
    const groups = {};
    for (const q of arr) (groups[q.exam_code + '|' + q.subject] = groups[q.exam_code + '|' + q.subject] || []).push(q);
    let touched = false;

    for (const key of Object.keys(groups)) {
      const [code, ...rest] = key.split('|');
      const subject = rest.join('|');
      const items = groups[key];
      let doc;
      try {
        const p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items });
        if (!p) { bump('對不到官方卷'); continue; }
        doc = mupdf.Document.openDocument(await fetchSheet('Q', code, p.c, p.s), 'application/pdf');
      } catch (e) { bump('取卷失敗'); continue; }
      papers++;

      const heads = [], pageLines = [];
      for (let pg = 0; pg < doc.countPages(); pg++) {
        let runs = [];
        try {
          const st = JSON.parse(doc.loadPage(pg).toStructuredText('preserve-whitespace').asJSON());
          for (const b of st.blocks || []) for (const l of b.lines || []) {
            const t = (l.text || '').normalize('NFC');
            if (!t.trim()) continue;
            runs.push({ x: l.bbox.x, y: l.bbox.y, w: l.bbox.w, t });
          }
        } catch { /* 這頁抽不到文字 */ }
        runs.sort((a, b) => a.y - b.y || a.x - b.x);
        const rows = [];
        for (const r of runs) {
          const row = rows.find(z => Math.abs(z.y - r.y) <= 4);
          if (row) row.runs.push(r); else rows.push({ y: r.y, runs: [r] });
        }
        const lines = rows.map(z => ({ y: z.y, x: Math.min(...z.runs.map(r => r.x)), t: joinRuns(z.runs) }));
        for (const l of lines) {
          // 題號有兩種排法：「73.」與單獨一行的「73」（醫事類兩種都有）。
          // 只認前者會讓整批卷「定位不到題號」。
          const m = /^(\d{1,3})\s*[.．、]/.exec(l.t.trim()) || /^(\d{1,3})(\s+\S|\s*$)/.exec(l.t.trim());
          if (m && l.x < 60) heads.push({ pg, y: l.y, n: +m[1] });
        }
        pageLines.push(lines);
      }
      heads.sort((a, b) => a.pg - b.pg || a.y - b.y);

      for (const q of items) {
        if (/【題組情境】/.test(String(q.question || ''))) continue;
        const hi = heads.findIndex(h => h.n === +q.number);
        if (hi < 0) { bump('定位不到題號'); continue; }
        const h = heads[hi], nx = heads[hi + 1];
        const seg = [];
        for (let pg = h.pg; pg <= (nx ? nx.pg : h.pg); pg++) {
          for (const l of pageLines[pg] || []) {
            if (pg === h.pg && l.y < h.y - 1) continue;
            if (nx && pg === nx.pg && l.y >= nx.y - 1) continue;
            if (FURNITURE.test(l.t.trim())) continue;
            seg.push(l.t.trim());
          }
        }
        if (!seg.length) { bump('抓不到這題的行'); continue; }
        let stem = seg[0].replace(/^\d{1,3}\s*[.．、]?\s*/, '');
        const opts = {};
        let cur = null;
        // 換行處若兩邊都是英數，原卷那裡本來就有一個空白（行尾被吃掉了）。
        // 不補的話「developmental coordination」＋「disorder）」會黏成一個字。
        const glue = (a, b) => (/[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b) ? a + ' ' + b : a + b);
        for (const t of seg.slice(1)) {
          const m = OPT.exec(t);
          if (m) { cur = m[1]; opts[cur] = t.slice(m[0].length); }
          else if (cur) opts[cur] = glue(opts[cur], t);
          else stem = glue(stem, t);
        }
        const vals = ['A', 'B', 'C', 'D'].map(k => opts[k]);
        if (!vals.every(v => v && v.trim())) { bump('重建不出四個選項'); continue; }
        if (new Set(vals.map(norm)).size < 4) { bump('重建的選項有重複'); continue; }

        const mend = (bankRaw, fullRaw) => {
          const kind = isTruncationOf(bankRaw, fullRaw);
          if (!kind) return null;
          // 被截尾的只接尾巴，保留原本的排版；中間掉一段的才整欄換。
          if (kind !== 'prefix') return fullRaw;
          const tail = tailAfter(fullRaw, norm(bankRaw).length);
          return tail ? String(bankRaw).replace(/\s+$/, '') + tail : fullRaw;
        };
        const patch = [];
        const sFix = mend(q.question, stem);
        if (sFix) patch.push(['question', sFix]);
        for (const k of ['A', 'B', 'C', 'D']) {
          const v = mend((q.options || {})[k], opts[k]);
          if (v) patch.push([k, v]);
        }
        if (!patch.length) continue;
        console.log(`${APPLY ? '✓' : '·'} ${exam} ${code} ${subject} #${q.number}  補 ${patch.map(p => p[0]).join(',')}`);
        for (const [k, v] of patch) {
          console.log(`    ${k} 原: ${String(k === 'question' ? q.question : q.options[k]).replace(/\s+/g, ' ').slice(0, 60)}`);
          console.log(`    ${k} 新: ${String(v).replace(/\s+/g, ' ').slice(0, 60)}`);
          if (APPLY) { if (k === 'question') q.question = v; else q.options[k] = v; }
        }
        if (APPLY) touched = true;
        fixed++;
      }
    }
    if (APPLY && touched) fs.writeFileSync(path.join(BK, f), JSON.stringify(j, null, 2), 'utf8');
  }
  console.log(`\n${APPLY ? '已修' : '可修'} ${fixed} 題｜掃過 ${papers} 卷`);
  if (Object.keys(why).length) console.log('跳過統計:', JSON.stringify(why, null, 1));
})().catch(e => { console.error(e.stack); process.exit(1); });
