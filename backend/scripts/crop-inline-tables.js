#!/usr/bin/env node
/**
 * 把「被攤平塞進題幹的表格」裁成圖。
 *
 * 症狀：原卷上是一張用線條畫的表（純文字排版，PDF 裡**沒有 image block**），
 * 爬蟲照閱讀順序把格子一格一格接起來塞進題幹，變成一串看不懂的字：
 *
 *   audiologist 107110 #22
 *     原卷 2-D 版面：欄標題「黃金標準測驗結果 / 有聽損 聽力正常 合計」，
 *                    列標題「篩檢結果 / 不通過 通過 合計」，格子裡是 A B A+B…
 *     題庫：「…下列敘述何者錯誤？黃金標準測驗結果有聽損 聽力正常 合計篩檢結果不通過」
 *            —— 攤平而且截斷，使用者看不出哪個數字對哪一格
 *
 * 既有四支補圖工具都不處理這一型：
 *   · extract-missing-figures.js  要「題幹與第一個選項之間是空白帶」或有嵌入圖塊；
 *     文字排版的表兩個條件都不成立（實測 audiologist 整個考試回報 0 張）
 *   · extract-side-figures / extract-post-figures / extract-ceec-figures 各管別的版面
 * 判定也漏：lib/image-ref.js 的 needsImage() 認得「圖N／表N」，認不得
 * 「下表為」「如下所示：」這種沒編號的寫法 —— 見 project_missing_table_figures。
 *
 * 判準全部靠版面幾何，不靠題幹用字：
 *   · 題號列在最左（x < stemX-10），題幹與選項在 stemX（該卷 x 的眾數）
 *   · **表格列 = x > stemX + 18 的列**。選項續行只縮到 stemX+11，不會誤中
 *   · 至少 2 列，而且其中**至少一列的文字找得到在題庫的題幹裡**
 *     → 同時證明「卷抓對了」「題號沒錯位」「待會兒刪的字是真的存在的字」
 *   · 表格不跨頁、裁出來要有深色像素（全白＝原卷本來就沒東西）
 *
 * 裁到圖之後，把題幹裡那串攤平的表格文字刪掉（只刪比對得上的那幾列）。
 *
 *   node scripts/crop-inline-tables.js [--exam=audiologist] [--list=cand.json] [--apply]
 *
 * --list 吃一份明確的候選清單 [{exam, code, subject, n}, …]，刻意不內建候選規則：
 * needsImage() 是盤點與補圖共用的單一來源，為了這一型去加寬它會讓健康報告灌水。
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { atomicWriteJson } = require('./lib/atomic-write');

const BK = path.join(__dirname, '..');
const IMG = path.join(BK, '..', 'frontend', 'public', 'question-images');
const APPLY = process.argv.includes('--apply');
const onlyExam = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];
const listFile = (process.argv.find(a => a.startsWith('--list=')) || '').split('=')[1];

const FURN = /代號[：:]\s*\d{3,6}|頁次[：:]\s*\d+\s*[－\-—–]\s*\d+|座號[：:]\s*_+/g;
const MK = /[-]/;
const NUMROW = /^(\d{1,3})\s*[．.、]?\s*$/;
const nz = s => String(s || '').replace(/\s+/g, '');

/**
 * 把題幹裡那段攤平的表格整段刪掉。
 *
 * 不能一格一格刪：表格有大量 2-3 字的短格（「合計」「通過」「A+B」），
 * 單獨拿去 indexOf 會打到題幹正文（「通過」在敘述裡也會出現），
 * 設個 4 字門檻又會把短格全留下來變成殘渣。
 *
 * 作法：爬蟲是**照閱讀順序**把格子接起來的，所以表格在題幹裡是**連續的一段**。
 * 用第一個夠長（≥4 字）的格子當錨點，然後沿著題幹往後走，逐格確認下一格就接在
 * 游標後面（容許最多 2 個字的雜訊）。接不上就停 —— 原卷的表常常只被抄進去一半，
 * 停在哪裡就刪到哪裡，不會多刪到後面的正文。
 *
 * 回傳 [新題幹, 刪掉幾格]。
 */
function cutTable(stem, cells, minAnchor = 4) {
  const map = [];
  let flat = '';
  for (let i = 0; i < stem.length; i++) if (!/\s/.test(stem[i])) { flat += stem[i]; map.push(i); }

  const seq = cells.map(nz).filter(Boolean);
  let start = -1, si = 0;
  for (let i = 0; i < seq.length; i++) {
    if (seq[i].length < minAnchor) continue;
    const at = flat.indexOf(seq[i]);
    if (at >= 0) { start = at; si = i; break; }
  }
  if (start < 0) return [stem, 0];

  // 不能照順序逐格比對：爬蟲接字用的是 PDF 內部的區塊順序，跟「先 y 再 x」的
  // 幾何排序不一樣（107110 #22 爬蟲接的是…合計→篩檢結果→不通過，幾何排序是
  // …合計→不通過→篩檢）。改成不管順序，只要**還沒用過的格子接得上游標**就吃掉。
  const used = new Array(seq.length).fill(false);
  used[si] = true;
  let cur = start + seq[si].length, hit = 1;
  for (;;) {
    let best = -1, bestAt = -1;
    for (let i = 0; i < seq.length; i++) {
      if (used[i]) continue;
      const at = flat.indexOf(seq[i], cur);
      if (at < 0 || at > cur + 2) continue;     // 接不上
      if (bestAt < 0 || at < bestAt || (at === bestAt && seq[i].length > seq[best].length)) { best = i; bestAt = at; }
    }
    if (best < 0) break;                        // 原卷的表常常只被抄進去一半，停在哪就刪到哪
    used[best] = true; cur = bestAt + seq[best].length; hit++;
  }
  // 錨點要夠長（≥4 字）才敢當起點，所以表格**左上角那種 2 字的格**（「類別」）會落在
  // 錨點前面，往前走一遍把它們吃掉，否則題幹會留下「…如下表：類別這些動態…」
  for (;;) {
    let best = -1, bestAt = -1;
    for (let i = 0; i < seq.length; i++) {
      if (used[i]) continue;
      const at = flat.lastIndexOf(seq[i], start - 1);
      if (at < 0 || at + seq[i].length < start - 2) continue;
      if (bestAt < 0 || at > bestAt) { best = i; bestAt = at; }
    }
    if (best < 0) break;
    used[best] = true; start = bestAt; hit++;
  }
  return [stem.slice(0, map[start]) + stem.slice(map[cur - 1] + 1), hit];
}

(async () => {
  const mupdf = await import('mupdf');
  if (!listFile) throw new Error('要給 --list=<候選清單.json>');
  const cands = JSON.parse(fs.readFileSync(listFile, 'utf8'));

  const why = {};
  let made = 0, skip = 0;
  const note = k => { why[k] = (why[k] || 0) + 1; skip++; };

  const examsIn = [...new Set(cands.map(c => c.exam))].filter(e => !onlyExam || e === onlyExam);
  for (const exam of examsIn) {
    // 大考中心不是考選部的卷，resolvePaper 找不到；它們走 extract-ceec-figures.js
    if (exam === 'gsat' || exam === 'ast') { cands.filter(c => c.exam === exam).forEach(() => note('大考中心的卷(走 ceec 工具)')); continue; }
    const f = exam === 'doctor1' ? 'questions.json' : `questions-${exam}.json`;
    if (!fs.existsSync(path.join(BK, f))) { note('找不到題庫檔:' + f); continue; }
    const bank = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const arr = Array.isArray(bank) ? bank : bank.questions;
    if (!arr) continue;

    const groups = {};
    for (const c of cands.filter(c => c.exam === exam)) {
      const k = c.code + '|' + c.subject;
      (groups[k] = groups[k] || []).push(c.n);
    }
    let touched = false;

    for (const key of Object.keys(groups)) {
      const [code, ...rest] = key.split('|');
      const subject = rest.join('|');
      const items = arr.filter(q => String(q.exam_code) === code && q.subject === subject);
      let p, doc;
      try {
        p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items });
        if (!p) { groups[key].forEach(() => note('對不到官方卷')); continue; }
        doc = mupdf.Document.openDocument(await fetchSheet('Q', code, p.c, p.s), 'application/pdf');
      } catch (e) {
        groups[key].forEach(() => note('抓卷失敗: ' + String(e.message).slice(0, 25)));
        continue;
      }

      const rows = [];
      for (let pg = 0; pg < doc.countPages(); pg++) {
        const page = doc.loadPage(pg);
        const st = page.toStructuredText('preserve-whitespace');
        for (const b of JSON.parse(st.asJSON()).blocks || []) {
          for (const l of b.lines || []) {
            const t = (l.text || '').normalize('NFC').replace(FURN, '');
            if (t.trim()) rows.push({ pg, y: Math.round(l.bbox.y), x: Math.round(l.bbox.x), h: Math.round(l.bbox.h || 14), t });
          }
        }
        st.destroy(); page.destroy();
      }
      rows.sort((a, b) => a.pg - b.pg || a.y - b.y || a.x - b.x);
      if (!rows.length) { groups[key].forEach(() => note('原卷抽不到文字')); doc.destroy(); continue; }

      const xc = {};
      rows.forEach(r => { xc[r.x] = (xc[r.x] || 0) + 1; });
      const stemX = +Object.entries(xc).sort((a, b) => b[1] - a[1])[0][0];
      const numAt = {};
      rows.forEach((r, i) => {
        const m = NUMROW.exec(r.t.trim());
        if (m && r.x < stemX - 10 && numAt[+m[1]] == null) numAt[+m[1]] = i;
      });

      for (const n of groups[key]) {
        const q = items.find(x => x.number === n);
        if (!q) { note('題庫找不到這題'); continue; }
        if (q.images && q.images.length) { note('已經有圖'); continue; }
        const i0 = numAt[n];
        if (i0 == null) { note('原卷找不到題號'); continue; }
        let i1 = rows.length;
        for (let i = i0 + 1; i < rows.length; i++) {
          const m = NUMROW.exec(rows[i].t.trim());
          if ((m && rows[i].x < stemX - 10 && +m[1] === n + 1) || MK.test(rows[i].t)) { i1 = i; break; }
        }
        const span = rows.slice(i0, i1);
        const indent = span.filter(r => r.x > stemX + 18);
        if (indent.length < 2) { note('沒有縮排的表格列'); continue; }
        if (new Set(indent.map(r => r.pg)).size > 1) { note('表格跨頁'); continue; }
        // 縮排的格子定出表格的 y 範圍，再把**落在這個範圍內的所有列**收進來 ——
        // 左側的列標題（「篩檢結果」）貼在左邊界，x 不夠大，只看 x 會把它留在題幹變殘渣
        const pg0 = indent[0].pg;
        const yA = Math.min(...indent.map(r => r.y)), yB = Math.max(...indent.map(r => r.y + r.h));
        const tbl = span.filter(r => r.pg === pg0 && r.y + r.h > yA - 2 && r.y < yB + 2);
        /*
         * 對位證明：要先確定「這一題的題號在原卷上指的真的是題庫這一題」。
         *
         * 兩條路，因為有兩種情況：
         *   A 表格文字被攤平塞進題幹 → 拿表格格子去對，對上就順便把它刪掉
         *   B 表格**完全沒進題幹**（爬蟲整張丟掉了）→ 沒東西可對，改拿題幹正文對。
         *     這一類其實最該補圖（使用者現在根本看不到表），一開始只走 A 會把它們全擋掉。
         */
        /*
         * 錨點一定要 ≥4 字。試過退到 2 字想多救幾題（有些表整張都是「雞排」「紅茶」
         * 這種短格），結果**一題都沒多救到，還弄壞兩題**：表格的短格常常跟正文同字，
         * railway-transport 111070 #2 刪成「列車從出發」（表格有一格是「臺北」）、
         * doctor1 100030 #99 刪成「某種的篩選方法」（表格有一格是「疾病」）。
         * 短格的表就讓它走情況 B：圖照掛，題幹不動。
         */
        const tblHit = tbl.some(r => nz(r.t).length >= 4 && nz(q.question).includes(nz(r.t)));
        const proseHit = span.some(r => r.x >= stemX - 2 && r.x <= stemX + 18
          && nz(r.t).length >= 8 && nz(q.question).includes(nz(r.t)));
        if (!tblHit && !proseHit) { note('原卷這一題對不到題庫題幹'); continue; }

        const pg = tbl[0].pg;
        const yTop = Math.min(...tbl.map(r => r.y));
        // 上緣貼齊「表格上方最後一行題幹」的下緣，否則會把題幹最後一行削進圖裡
        const above = span.filter(r => r.pg === pg && r.y + r.h <= yTop - 1);
        const topLimit = above.length ? Math.max(...above.map(r => r.y + r.h)) + 3 : yTop - 10;
        const top = Math.max(topLimit, yTop - 10);
        const bot = Math.max(...tbl.map(r => r.y + r.h)) + 10;
        if (bot - top < 24) { note('表格帶太矮'); continue; }

        const page = doc.loadPage(pg);
        const pm = page.toPixmap(mupdf.Matrix.scale(3, 3), mupdf.ColorSpace.DeviceRGB, false, true);
        const png = Buffer.from(pm.asPNG());
        pm.destroy(); page.destroy();
        const meta = await sharp(png).metadata();
        const t0 = Math.max(0, Math.round(top * 3));
        const t1 = Math.min(meta.height, Math.round(bot * 3));
        // sharp 的 trim() 在 pipeline 裡排在 extract() 之前，串同一條鏈會
        // 「bad extract area」。必須分兩段（見 project_option_images）。
        const cutBuf = await sharp(png).extract({ left: 0, top: t0, width: meta.width, height: t1 - t0 }).png().toBuffer();
        const stats = await sharp(cutBuf).stats();
        if (!stats.channels.some(c => c.min < 200)) { note('該區塊是空白'); continue; }
        let out;
        try { out = await sharp(await sharp(cutBuf).trim({ threshold: 12 }).toBuffer()).webp({ quality: 88 }).toBuffer(); }
        catch { out = await sharp(cutBuf).webp({ quality: 88 }).toBuffer(); }

        // 情況 B（表格沒進題幹）只掛圖、不動題幹
        let stem = q.question, removed = 0;
        if (tblHit) {
          [stem, removed] = cutTable(q.question, tbl.map(r => r.t));
          stem = stem.replace(/\s+/g, ' ').replace(/\s+([，。？！：；])/g, '$1').replace(/_{3,}/g, ' ').replace(/\s+/g, ' ').trim();
          if (!removed) { note('題幹裡對不到連續的表格文字'); continue; }
        }
        /*
         * 兩道品質閘。沒有這兩道的話實測出過：
         *   · railway-admin 106070 #24 的錨點打在一個很長的格子上，整段刪完**題幹變成空字串**
         *   · public-health 110180 #19 只刪掉一半，題幹中間留著「疾病D是否A地區8」這種殘渣
         * 殘渣比完全不處理更糟 —— 使用者會以為題目本來就長這樣。寧可不做。
         */
        if (tblHit && nz(stem).length < 12) { note('刪完題幹變太短(錨點打錯)'); continue; }
        // 殘渣要比「出現次數有沒有減少」，不能只看「刪完還在不在」：
        // 表格裡的字常常也出現在題幹正文（speech-therapist 107110 #32 的「敏感度」
        // 表頭有、問句也有），只看在不在會把清乾淨的題誤判成有殘渣。
        const count = (hay, needle) => { let c = 0, i = 0; for (;;) { const at = hay.indexOf(needle, i); if (at < 0) break; c++; i = at + 1; } return c; };
        const flatOrig = nz(q.question), flatNew = nz(stem);
        const left = !tblHit ? [] : tbl.filter(r => {
          const c = nz(r.t);
          return c.length >= 3 && count(flatNew, c) > 0 && count(flatNew, c) >= count(flatOrig, c);
        });
        if (left.length) { note(`題幹還留著 ${left.length} 格表格文字(殘渣)`); continue; }
        /*
         * 第三道閘：**不能刪到題幹正文**。
         * 表格的格子常常跟正文用同一個詞：railway-transport 111070 #2 的表格有一格
         * 是「臺北」，而題幹正文也寫「列車從臺北出發」—— 刪完變成「列車從出發」。
         * doctor1 100030 #99 的「疾病」也一樣（「某種疾病的篩選方法」→「某種的篩選方法」）。
         * 殘渣閘抓不到這種**多刪**，要反過來驗：原卷的題幹正文行，刪之前對得上的，
         * 刪之後必須還對得上。
         */
        if (tblHit) {
          const prose = span.filter(r => r.x >= stemX - 2 && r.x <= stemX + 18
            && nz(r.t).length >= 8 && flatOrig.includes(nz(r.t)));
          const broke = prose.filter(r => !flatNew.includes(nz(r.t)));
          if (broke.length) { note(`刪到題幹正文了(${broke.length} 行)`); continue; }
        }
        const name = `${exam}_${code}_${p.s || 'x'}_${n}_tbl.webp`;
        const m2 = await sharp(out).metadata();
        console.log(`${APPLY ? '✓' : '·'} ${exam} ${code} ${subject} #${n}  ${m2.width}×${m2.height}  ${tblHit ? `題幹刪 ${removed}/${tbl.length} 列` : "題幹不動(表格本來就沒進題幹)"}`);
        console.log(`    ${stem}`);
        if (APPLY) {
          fs.writeFileSync(path.join(IMG, name), out);
          q.images = [`/question-images/${name}`];
          q.question = stem;
          touched = true;
        } else {
          fs.writeFileSync(path.join(require('os').tmpdir(), name), out);
        }
        made++;
      }
      doc.destroy();
    }
    if (APPLY && touched) atomicWriteJson(path.join(BK, f), bank);
  }
  console.log(`\n可裁 ${made} 張｜跳過 ${skip}`);
  if (skip) console.log('跳過原因:', JSON.stringify(why, null, 1));
  if (!APPLY) console.log(`（試跑；圖先放在 ${require('os').tmpdir()}，加 --apply 才寫入）`);
})().catch(e => { console.error('FAIL', e.stack); process.exit(1); });
