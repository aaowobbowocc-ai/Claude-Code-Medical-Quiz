#!/usr/bin/env node
/**
 * 補「圖／表排在選項右邊，但題幹沒講方位」的題。
 *
 * 四支既有工具都抓不到這一種：
 *   · extract-missing-figures.js  只看「題幹與第一個選項之間的空白帶」
 *   · extract-side-figures.js     要題幹自己說「右圖」「左圖」，而且認的是嵌入圖片
 *   · extract-post-figures.js     郵局卷專用（一頁兩大欄）
 *   · extract-ceec-figures.js     大考中心專用（靠圖說定位）
 *
 * 這一種的圖是**畫出來的表格或向量圖**（語言治療的語音紀錄表、聽力圖），
 * PDF 裡沒有 image block，只有一堆排在右半邊的短行：
 *
 *   x 47 y 89  "35"
 *   x 72 y 89  "下列何種分析方式最適合表一的語言紀錄？"
 *   x 72 y112  "相關分析（relational analysis）"      x367 y116 "表一：語言紀錄"   ← 表在右邊
 *   x 72 y135  "獨立分析（independent analysis）"     x336 y140 "目標音" …
 *
 * 判準（刻意收緊，寧可少補也不要掛錯圖）：
 *   · 題幹要指名「圖N／表N」（原卷自己講的），而且 needsImage() 成立
 *   · 右半邊（x ≥ RIGHT_X）的行要**至少 4 行**、y 跨距 ≥ 60pt
 *     —— 橫排的四個選項也在右半邊，但它們擠在同一個 y 上，跨距是 0
 *   · 範圍只到下一題題號為止，不會吃到隔壁題的圖
 *   · 左界取「同一段 y 裡左欄文字的最右緣」，免得把選項的尾巴裁進來
 *
 *   node scripts/extract-column-figures.js [--exam=speech-therapist] [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { needsImage } = require('./lib/image-ref');

const BK = path.join(__dirname, '..');
const IMG = path.join(BK, '..', 'frontend', 'public', 'question-images');
const APPLY = process.argv.includes('--apply');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];

const RIGHT_X = 260;          // 右半邊的起點（A4 寬 595，正文欄大約到 250）
const MIN_LINES = 4;
const MIN_SPAN = 60;
// 頁眉與頁碼：代號：5201／頁次：12－6／（請接續背面）
const FURNITURE = /^(代號|頁次|編號)[：:]|^第\s*\d+\s*頁|請接續|^-\s*\d+\s*-$/;
const REF = /[圖表]\s*([0-9０-９]{1,2}|[一二三四五六七八九十]{1,3})/;

(async () => {
  const sharp = require('sharp');
  const mupdf = await import('mupdf');
  let made = 0;
  const why = {};
  const bump = k => { why[k] = (why[k] || 0) + 1; };

  for (const f of fs.readdirSync(BK).filter(x => /^questions(-[a-z0-9-]*)?\.json$/.test(x))) {
    const exam = f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '');
    if (only && exam !== only) continue;
    if (exam === 'gsat' || exam === 'ast') continue;        // 大考中心走自己那支
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    if (!arr) continue;
    const targets = arr.filter(q => !q.no_image_in_source
      && (!q.incomplete || q.incomplete === 'missing_image')
      && !(q.images && q.images.length) && !q.image_url && !q.image && !q.option_images
      && REF.test(String(q.question || '')) && needsImage(q));
    if (!targets.length) continue;

    const groups = {};
    for (const q of targets) (groups[q.exam_code + '|' + q.subject] = groups[q.exam_code + '|' + q.subject] || []).push(q);
    let touched = false;

    for (const key of Object.keys(groups)) {
      const [code, ...rest] = key.split('|');
      const subject = rest.join('|');
      const items = arr.filter(q => q.exam_code === code && q.subject === subject);
      let doc;
      try {
        const p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items });
        if (!p) { bump('對不到官方卷'); continue; }
        doc = mupdf.Document.openDocument(await fetchSheet('Q', code, p.c, p.s), 'application/pdf');
      } catch (e) { bump('卷開不起來'); continue; }

      // 收齊所有行與題號
      const pages = [];
      const heads = [];
      for (let pg = 0; pg < doc.countPages(); pg++) {
        const lines = [];
        try {
          const st = JSON.parse(doc.loadPage(pg).toStructuredText('preserve-whitespace').asJSON());
          for (const b of st.blocks || []) for (const l of b.lines || []) {
            const t = (l.text || '').normalize('NFC').trim();
            if (!t) continue;
            lines.push({ x: l.bbox.x, y: l.bbox.y, w: l.bbox.w, h: l.bbox.h, t });
            const m = /^(\d{1,3})\s*$/.exec(t) || /^(\d{1,3})\s*[.、．]/.exec(t);
            if (m && l.bbox.x < 90) heads.push({ pg, y: l.bbox.y, n: +m[1], x: l.bbox.x });
          }
        } catch { /* 這一頁抽不出文字 */ }
        lines.sort((a, b) => a.y - b.y || a.x - b.x);
        pages.push(lines);
      }

      for (const q of groups[key]) {
        const n = +q.number;
        const head = heads.find(h => h.n === n);
        if (!head) { bump('定位不到題號'); continue; }
        const next = heads.filter(h => (h.pg > head.pg) || (h.pg === head.pg && h.y > head.y + 4))
          .sort((a, b) => a.pg - b.pg || a.y - b.y)[0];
        const yBot = (next && next.pg === head.pg) ? next.y - 4 : Infinity;
        const pls = pages[head.pg];
        const band = pls.filter(l => l.y >= head.y - 2 && l.y <= yBot && !FURNITURE.test(l.t));
        const right = band.filter(l => l.x >= RIGHT_X);
        if (right.length < MIN_LINES) { bump('右半邊沒有成塊的內容'); continue; }
        const y0 = Math.min(...right.map(l => l.y));
        const y1 = Math.max(...right.map(l => l.y + (l.h || 12)));
        if (y1 - y0 < MIN_SPAN) { bump('右半邊的行擠在同一條線上(是橫排選項)'); continue; }
        // 左界：同一段 y 裡左欄文字的最右緣，與右半邊最左緣，取較大的
        const leftTail = band.filter(l => l.x < RIGHT_X && l.y + (l.h || 12) > y0 - 2 && l.y < y1 + 2);
        const x0 = Math.max(
          Math.min(...right.map(l => l.x)) - 12,
          leftTail.length ? Math.max(...leftTail.map(l => l.x + (l.w || 0))) + 6 : 0);
        const x1 = Math.max(...right.map(l => l.x + (l.w || 0))) + 10;
        if (x1 - x0 < 60) { bump('框太窄'); continue; }

        const name = `${exam}_${code}_q${n}_fig.webp`;
        if (APPLY) {
          try {
            const page = doc.loadPage(head.pg);
            const pm = page.toPixmap(mupdf.Matrix.scale(3, 3), mupdf.ColorSpace.DeviceRGB, false, true);
            const png = Buffer.from(pm.asPNG());
            const meta = await sharp(png).metadata();
            const L = Math.max(0, Math.round(x0 * 3)), T = Math.max(0, Math.round((y0 - 6) * 3));
            const W = Math.min(meta.width - L, Math.round((x1 - x0) * 3));
            const H = Math.min(meta.height - T, Math.round((y1 - y0 + 12) * 3));
            if (W < 80 || H < 80) { bump('裁出來太小'); continue; }
            const base = await sharp(png).extract({ left: L, top: T, width: W, height: H }).png().toBuffer();
            const s2 = await sharp(base).stats();
            if (!s2.channels.some(c => c.min < 200)) { bump('該區塊是空白'); continue; }
            let out = base;
            try { out = await sharp(base).trim({ threshold: 12 }).toBuffer(); } catch (_) { /* 全白會拋 */ }
            await sharp(out).webp({ quality: 88 }).toFile(path.join(IMG, name));
            q.images = [`/question-images/${name}`];
            // 補上圖不等於修好這一題：清 incomplete 之前先驗選項
            if (q.incomplete === 'missing_image') {
              const vals = ['A', 'B', 'C', 'D'].map(k =>
                String((q.options || {})[k] == null ? '' : q.options[k]).replace(/\s+/g, ''));
              if (vals.every(Boolean) && new Set(vals).size === 4) delete q.incomplete;
              else q.incomplete = 'broken_options';
            }
            touched = true;
          } catch (e) { bump('裁圖失敗:' + String(e.message).slice(0, 28)); continue; }
        }
        if (process.env.FIG_DEBUG) console.log(`  + ${exam} ${code} ${subject} #${n} p${head.pg}`
          + ` x${Math.round(x0)}~${Math.round(x1)} y${Math.round(y0)}~${Math.round(y1)} 行${right.length}`);
        made++;
      }
    }
    if (APPLY && touched) fs.writeFileSync(path.join(BK, f), JSON.stringify(j, null, 2), 'utf8');
  }
  console.log(`${APPLY ? '已產生' : '可產生'} ${made} 張圖`);
  if (Object.keys(why).length) console.log('跳過原因:', JSON.stringify(why, null, 1));
})().catch(e => { console.error(e.stack); process.exit(1); });
