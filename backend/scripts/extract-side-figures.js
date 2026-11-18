#!/usr/bin/env node
/**
 * 補「圖排在題幹旁邊」的題 —— 題幹自己說了「右圖」「左圖」。
 *
 * `extract-missing-figures.js` 只看「題幹與第一個選項之間的空白帶」，
 * 這一類圖不在那裡，所以它對這 19 題回報 0 張。實際版面長這樣
 * （中醫一階 103030 第 6 頁）：
 *
 *   x 47 y292  "70"
 *   x 72 y292  "下列何者不是右圖藥材之功效？"      ← 題幹一行
 *                                   圖 x271 y300 w138 h92   ← 圖在右邊
 *   x 72 y306  "除煩安神"                          ← 選項從圖的左邊繼續往下
 *   x 72 y320  "活血調經"
 *
 * 判準刻意保守，只做「題幹指名方位」的題：
 *   · 題幹要出現「右圖」或「左圖」（這是原卷自己講的，不是我們猜的）
 *   · 圖塊要落在**本題題號到下一題題號之間**
 *   · 右圖 → 圖塊要在文字欄右邊（x ≥ 題號 x + 180）；左圖反之
 *   · 只提一個方位時，範圍內必須**剛好一塊**圖；兩個方位都提到
 *     （「從左圖到右圖的過程中」）就把範圍內的圖全部框進來
 *
 * 圖說（「（每格0.1 公分）」這種）若貼在圖下方 24pt 內會一起框進來。
 *
 *   node scripts/extract-side-figures.js [--exam=tcm1] [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { needsImage, figName } = require('./lib/image-ref');

const BK = path.join(__dirname, '..');
const IMG = path.join(BK, '..', 'frontend', 'public', 'question-images');
const APPLY = process.argv.includes('--apply');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];
const MARK = { '': 'A', '': 'B', '': 'C', '': 'D' };

const SIDE = /([左右])圖/g;

(async () => {
  const sharp = require('sharp');
  const mupdf = await import('mupdf');
  let made = 0, skip = 0;
  const why = {};
  const bump = k => { why[k] = (why[k] || 0) + 1; skip++; };

  for (const f of fs.readdirSync(BK).filter(x => /^questions(-[a-z0-9-]*)?\.json$/.test(x))) {
    const exam = f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '');
    if (only && exam !== only) continue;
    if (exam === 'gsat' || exam === 'ast') continue;       // 大考中心走 extract-ceec-figures.js
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    if (!arr) continue;
    // 候選放寬成 needsImage()：題幹沒講方位、但卷上確實有一塊圖排在旁邊的
    // 也要補（中醫二階 103030「圖示衝脈…」）。方位只影響下面挑圖塊的那一步。
    const targets = arr.filter(q => (!q.incomplete || q.incomplete === 'missing_image')
      && !q.no_image_in_source
      && !(q.images && q.images.length) && !q.image_url && !q.image && !q.option_images
      && needsImage(q));
    if (!targets.length) continue;

    const groups = {};
    for (const q of targets) (groups[q.exam_code + '|' + q.subject] = groups[q.exam_code + '|' + q.subject] || []).push(q);
    let touched = false;

    for (const key of Object.keys(groups)) {
      const [code, ...rest] = key.split('|');
      const subject = rest.join('|');
      const items = arr.filter(q => q.exam_code === code && q.subject === subject);
      let doc, paperS = '';
      try {
        const p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items });
        if (!p) { groups[key].forEach(() => bump('對不到官方卷')); continue; }
        paperS = p.s;
        doc = mupdf.Document.openDocument(await fetchSheet('Q', code, p.c, p.s), 'application/pdf');
      } catch (e) { groups[key].forEach(() => bump('取卷失敗: ' + String(e.message).slice(0, 24))); continue; }

      // 逐頁收題號、文字行、嵌入圖塊
      const heads = [], lines = [], figs = [];
      for (let pg = 0; pg < doc.countPages(); pg++) {
        try {
          const page = doc.loadPage(pg);
          const si = JSON.parse(page.toStructuredText('preserve-images').asJSON());
          const bnd = page.getBounds();
          const area = (bnd && bnd.length === 4) ? Math.abs((bnd[2] - bnd[0]) * (bnd[3] - bnd[1])) : 0;
          const bs = (si.blocks || []).filter(b => b.type && b.type !== 'text' && b.bbox
            && b.bbox.w >= 40 && b.bbox.h >= 25);
          // 掃描檔（整頁一張圖）要擋掉，否則每一題都「有圖」
          if (!(area > 0 && bs.some(b => b.bbox.w * b.bbox.h > area * 0.6)))
            for (const b of bs) figs.push({ pg, x: b.bbox.x, y: b.bbox.y, w: b.bbox.w, h: b.bbox.h });
        } catch { /* 這頁抽不到圖塊 */ }
        const st = JSON.parse(doc.loadPage(pg).toStructuredText('preserve-whitespace').asJSON());
        for (const b of st.blocks || []) for (const l of b.lines || []) {
          const t = (l.text || '').normalize('NFC');
          if (!t.trim()) continue;
          const row = { pg, x: l.bbox.x, y: l.bbox.y, w: l.bbox.w, h: l.bbox.h, t: t.trim() };
          lines.push(row);
          const m = /^(\d{1,3})\s*$/.exec(row.t) || /^(\d{1,3})\s*[.、]/.exec(row.t);
          if (m && row.x < 90) heads.push({ ...row, n: +m[1] });
        }
      }
      heads.sort((a, b) => a.pg - b.pg || a.y - b.y);

      for (const q of groups[key]) {
        const n = +q.number;
        const head = heads.find(h => h.n === n);
        if (!head) { bump('定位不到題號'); continue; }
        const next = heads.find(h => h.pg === head.pg && h.y > head.y + 5);
        const yBot = next ? next.y : head.y + 320;

        const sides = new Set(String(q.question).match(SIDE) || []);
        // 題幹沒講方位時（中醫二階「圖示衝脈在腹部並何經而上行？」「圖中的針法」），
        // 預設找右邊：中文卷的圖排在左邊的極少，而且這條路要求範圍內**剛好一塊**圖，
        // 真的排在左邊就會以「這題範圍內沒有嵌入圖塊」跳過，不會掛錯圖。
        const wantRight = sides.size === 0 || [...sides].some(s => s[0] === '右');
        const wantLeft = [...sides].some(s => s[0] === '左');
        const both = wantRight && wantLeft;

        /*
         * 圖排在右欄時常常**比這一題還高**：下一題的題號已經在左欄排下去了，
         * 圖還在右邊往下長（聽力師 100140 #1 的測試流程圖 y275~505，#2 的題號在 y340）。
         * 題幹自己講了方位的，就只要求「圖的上緣」落在這一題範圍內；
         * 沒講方位的仍要求整塊都在範圍內 —— 那條路沒有別的證據，不能放寬。
         */
        const loose = sides.size > 0;
        let cand = figs.filter(g => g.pg === head.pg && g.y >= head.y - 14
          && (loose ? g.y <= yBot + 4 : g.y + g.h <= yBot + 4));
        /*
         * 「圖在右邊」原本只看固定的 x ≥ 題號 x + 180。選項很短的時候圖會往左靠，
         * 這條就擋掉了真的排在旁邊的圖（中醫二階 101110 #27 的耳穴圖 x181，
         * 選項「甲乙丙丁」只有一個字、排在 x72）。
         * 補一條幾何退路：圖所在的那一段 y 範圍裡，**沒有任何一行文字從圖的左邊
         * 穿進圖裡**，就表示它確實站在文字欄旁邊的空白。
         * ⚠️ 只看「起點在圖左邊、右緣越過圖左緣」的行 —— 圖**裡面**的標籤
         *   （起點就在圖內）不算，否則有標籤的圖全部會被判成跟文字重疊。
         */
        const clearOfText = g => {
          // 不能用「一行都不准穿進來」：題幹的第一行本來就與圖的上緣齊平
          //（#27 的題幹 y572 就壓在圖 y569 的頭上），那樣每一題都會被擋掉。
          // 改看**被文字穿過的高度佔圖多少**，兩成以內就算站在旁邊的空白。
          const crossed = lines.filter(l => l.pg === g.pg
            && l.x < g.x - 6 && l.x + (l.w || 0) > g.x + 6
            && l.y + (l.h || 12) > g.y && l.y < g.y + g.h);
          const covered = crossed.reduce((s, l) =>
            s + Math.min(l.y + (l.h || 12), g.y + g.h) - Math.max(l.y, g.y), 0);
          return covered <= g.h * 0.2;
        };
        if (!both) cand = cand.filter(g => wantRight
          ? (g.x >= head.x + 180 || (g.x > head.x + 60 && clearOfText(g)))
          : g.x < head.x + 180);
        if (!cand.length) { bump('這題範圍內沒有嵌入圖塊'); continue; }
        // 一張照片常被 PDF 切成上下相接的幾條：x 範圍幾乎相同、上下幾乎沒有縫。
        // 這種要合起來當一張（tcm1 102030 #41 的 x299-480 y607-694＋y694-781），
        // 不是「分不清」。並排的兩塊（真的兩張圖）才算分不清。
        const stacked = cand.length > 1 && (() => {
          const s = [...cand].sort((a, b) => a.y - b.y);
          for (let i = 1; i < s.length; i++) {
            if (Math.abs(s[i].x - s[i - 1].x) > 6) return false;
            if (Math.abs((s[i].x + s[i].w) - (s[i - 1].x + s[i - 1].w)) > 6) return false;
            if (s[i].y - (s[i - 1].y + s[i - 1].h) > 4) return false;
          }
          return true;
        })();
        if (!both && cand.length > 1 && !stacked) { bump(`範圍內有 ${cand.length} 塊圖，分不清`); continue; }

        let x0 = Math.min(...cand.map(g => g.x)), x1 = Math.max(...cand.map(g => g.x + g.w));
        let y0 = Math.min(...cand.map(g => g.y)), y1 = Math.max(...cand.map(g => g.y + g.h));
        // 圖的上緣常常跟題幹**最後一行**齊平（圖塊的外框比實際的畫面高一點），
        // 照 bbox 裁會在左上角留下半句題幹（tcm2 101110 #27 裁出「何處？」）。
        // 上緣那 20% 之內若有文字行橫穿過去，就把上緣壓到那一行的下方 ——
        // 圖塊上面那一截本來就是空白，不會裁掉畫面。
        for (const l of lines) {
          if (l.pg !== head.pg) continue;
          if (l.x >= x0 - 6 || l.x + (l.w || 0) <= x0 + 6) continue;
          const bot = l.y + (l.h || 12);
          if (bot > y0 && bot <= y0 + (y1 - y0) * 0.2) y0 = bot + 1;
        }
        /*
         * 上一題的選項／題幹最後一行常常**壓在圖的上緣**：放射師 099010 #64 的圖
         * 從 y150 開始，#63 的選項「2-4 cm」在 y141、字高 12，字腳 y153 已經進到
         * 圖裡了。照 bbox 裁（再加 3pt 邊距）就在圖的頂端印半行別題的選項
         * （實測中醫二階 099130 #77 裁進「(B)督脈 (C)足少陽經 (D)手太陽經」、
         *  物治 099130 #63 裁進半行題幹）。
         * 上面那條只擋「從左邊穿進圖裡」的行，這種整行在圖**上方**、只有字腳越線的擋不到。
         * ⚠️ 只看起點在 y0 之上的行 —— 圖裡面的標籤 y 都 ≥ y0，不會被這條動到。
         */
        let topGuard = 0;
        for (const l of lines) {
          if (l.pg !== head.pg) continue;
          const bot = l.y + (l.h || 12);
          // 字腳只差幾 pt 沒碰到上緣的也要擋：裁圖會往上留 3pt 邊距，
          // 那半行照樣被邊距吃回來（物治 099130 #63 實測）。
          if (l.y >= y0 || bot <= y0 - 4) continue;
          if (l.x + (l.w || 0) < x0 - 4 || l.x > x1 + 4) continue;
          topGuard = Math.max(topGuard, bot + 1);
        }
        if (topGuard) y0 = Math.max(y0, topGuard);

        // 圖下方 24pt 內、橫向對得上的短行是圖說（「（每格0.1 公分）」），一起框進來。
        // ⚠️ 選項與題號也是短行：圖排在左欄時選項就貼在圖下面，
        //    一起框進來會把答案選項裁進圖裡（speech-therapist 105090 #56 實測，
        //    裁出來的圖下面印著「(A)透明」）。
        const OPTLINE = /^[Ⓐ-Ⓓ-]|^[（(]?[A-EＡ-Ｅ][）).、]|^\d{1,3}\s*$/;
        // 圖說不可能跨到下一塊圖裡。沒有這道上限時，#67 的框會往下吃到 #68 的照片
        //（裁出來的圖下緣印著「(B)」和半張別的藥材）。
        const nextFig = figs.filter(g => g.pg === head.pg && g.y >= y1 - 2)
          .sort((a, b) => a.y - b.y)[0];
        const capLimit = Math.min(y1 + 24, nextFig ? nextFig.y - 2 : Infinity);
        // 圖說不會從圖的左邊很遠的地方開始。原本寫 l.x + l.w < x0 - 20（只要
        // 右緣碰得到就算），於是貼左邊界的題幹短行也被收進來，x0 被拉到 72，
        // 整段題幹與選項都裁進圖裡（中醫二階 103030 #4、#45 實測）。
        const origX0 = x0;
        for (const l of lines) {
          if (l.pg !== head.pg) continue;
          if (l.y < y1 - 2 || l.y > capLimit) continue;
          if (l.x < origX0 - 20 || l.x > x1 + 20) continue;
          if (l.t.length > 20 || OPTLINE.test(l.t) || MARK[l.t[0]]) continue;
          y1 = Math.max(y1, l.y + (l.h || 12));
          x0 = Math.min(x0, l.x); x1 = Math.max(x1, l.x + l.w);
        }

        /*
         * 下緣同理：裁圖往下留 6pt，下一行題幹的字頭就露在圖的底部
         *（醫師二階 099130 #18 的食道攝影下面印著半行「體重減少 10 公斤」）。
         * 圖說已經在上面收進 y1 了，這裡只看**還在 y1 下面**的行。
         */
        let botGuard = Infinity;
        for (const l of lines) {
          if (l.pg !== head.pg) continue;
          if (l.y < y1 - 1) continue;
          if (l.x + (l.w || 0) < x0 - 4 || l.x > x1 + 4) continue;
          botGuard = Math.min(botGuard, l.y - 1);
        }

        const name = figName(exam, code, paperS, n);
        console.log(`${APPLY ? '✓' : '·'} ${exam} ${code} #${n}  ${both ? '左右兩張' : (wantRight ? '右圖' : '左圖')}` +
          `  ${cand.length} 塊  x${Math.round(x0)}-${Math.round(x1)} y${Math.round(y0)}-${Math.round(y1)}`);
        if (APPLY) {
          try {
            const page = doc.loadPage(head.pg);
            const pm = page.toPixmap(mupdf.Matrix.scale(3, 3), mupdf.ColorSpace.DeviceRGB, false, true);
            const png = Buffer.from(pm.asPNG());
            const meta = await sharp(png).metadata();
            const L = Math.max(0, Math.round(x0 * 3) - 9);
            // 上緣的邊距不能越過 topGuard，否則剛擋掉的那半行又被邊距吃回來
            const T = Math.max(topGuard ? Math.round(topGuard * 3) : 0, Math.round(y0 * 3) - 9);
            const W = Math.min(meta.width - L, Math.round((x1 - x0) * 3) + 18);
            const H = Math.min(meta.height - T,
              Number.isFinite(botGuard) ? Math.max(0, Math.round(botGuard * 3) - T) : Infinity,
              Math.round((y1 - y0) * 3) + 18);
            if (W < 90 || H < 60) { bump('成品尺寸過小'); continue; }
            // sharp 0.34：extract 與 trim 不能串在同一條 pipeline，要分兩段
            const buf = await sharp(png).extract({ left: L, top: T, width: W, height: H }).png().toBuffer();
            const stats = await sharp(buf).stats();
            if (!stats.channels.some(c => c.min < 200)) { bump('裁出來是空白'); continue; }
            let out = sharp(buf);
            try { out = sharp(await sharp(buf).trim({ threshold: 12 }).toBuffer()); } catch { out = sharp(buf); }
            await out.webp({ quality: 88 }).toFile(path.join(IMG, name));
            q.images = [`/question-images/${name}`];
            // 補上圖不等於修好這一題：清掉 missing_image 會把題目放回前端，
            // 選項本身要是壞的（空的、四個重複），使用者馬上看到「選項重複」。
            // 與 extract-missing-figures.js 同一道把關。
            if (q.incomplete === 'missing_image') {
              const vals = ['A', 'B', 'C', 'D'].map(key =>
                String((q.options || {})[key] == null ? '' : q.options[key]).replace(/\s+/g, ''));
              if (vals.every(Boolean) && new Set(vals).size === 4) delete q.incomplete;
              else q.incomplete = 'broken_options';
            }
            touched = true;
          } catch (e) { bump('裁圖失敗: ' + String(e.message).slice(0, 26)); continue; }
        }
        made++;
      }
    }
    if (APPLY && touched) fs.writeFileSync(path.join(BK, f), JSON.stringify(j, null, 2), 'utf8');
  }

  console.log(`\n${APPLY ? '已產生' : '可產生'} ${made} 張圖｜跳過 ${skip}`);
  if (Object.keys(why).length) console.log('跳過原因:', JSON.stringify(why, null, 1));
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})().catch(e => { console.error(e.stack); process.exit(1); });
