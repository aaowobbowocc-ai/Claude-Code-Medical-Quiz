#!/usr/bin/env node
/**
 * 補 99 年（2010）的題庫。
 *
 * 為什麼到現在才做：99 年的卷**用 pdfjs 讀出來是整頁亂碼**
 *   「99年 理療 99年力 類 理理理 1 不 801.252 不 …」
 * 現有的爬蟲全部走 pdfjs / pdf-parse，所以 99 年一直被當成「沒有卷」。
 * 其實 mupdf 的 toStructuredText 讀得乾乾淨淨（醫師一階 100/100 題、
 * 護理師 80/80 題，四個選項全齊），改用 lib/moex-paper-options 就拿得到。
 *
 * 四個場次（場次碼每年都不一樣，不要沿用別年的）：
 *   099010 第一次 030 系列（醫師／藥師／醫檢／護理／物治／中醫／營養／心理師／語言）
 *   099020 第一次 020 系列（牙醫／職治／呼治／獸醫）
 *   099110 第二次 020 系列（＋醫事放射師）
 *   099130 第二次 030 系列（＋聽力師）
 *
 * 答案有三種來源，依序試：
 *   1. 卷上直接標 `<正確答案>`（020 系列整批如此）
 *   2. t=S 標準答案卷（聽力師）
 *   3. t=M 更正答案卷 —— 030 系列只有這個，但它本文就含完整的標準答案表
 *      （「題序 01 02 …」兩列一組），parseAnswerSheet 解得出來。
 *   答案欄是「#」＝送分，整題不收。
 *
 * subject_tag / stage_id 照**同科目最早一年的題號分段**套用
 * （護理師「基礎醫學」1-16 解剖、17-32 生理…，100/101 年完全一致）。
 * 題數對不上就不套、整卷不收，免得分段錯位。
 *
 *   node scripts/scrape-year-99.js [--exam=vet] [--apply]
 */
const fs = require('fs');
const path = require('path');
const { fetchSheet } = require('./lib/moex-paper-resolve');
const { parseAnswerSheet } = require('./lib/moex-answer-sheet');
const { readPaperOptions, nz } = require('./lib/moex-paper-options');
const { needsImage } = require('./lib/image-ref');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];
const TARGETS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'year-99-papers.json'), 'utf8'));
const SESSION = { '099010': '第一次', '099020': '第一次', '099110': '第二次', '099130': '第二次' };
const KEYS = ['A', 'B', 'C', 'D'];
const fileOf = exam => (exam === 'doctor1' ? 'questions.json' : `questions-${exam}.json`);

/** 同科目最早一年的「題號 → tag」分段 */
function tagPlan(arr, subject) {
  const years = [...new Set(arr.filter(q => q.subject === subject).map(q => String(q.exam_code)))].sort();
  for (const code of years) {
    const qs = arr.filter(q => String(q.exam_code) === code && q.subject === subject)
      .sort((a, b) => a.number - b.number);
    if (!qs.length || !qs[0].subject_tag) continue;
    const plan = {};
    for (const q of qs) plan[q.number] = { tag: q.subject_tag, name: q.subject_name, stage: q.stage_id };
    return { plan, from: code, n: qs.length, max: qs[qs.length - 1].number };
  }
  return null;
}

(async () => {
  const mupdf = await import('mupdf');
  const summary = [];
  const byFile = {};

  for (const t of TARGETS) {
    if (only && t.exam !== only) continue;
    const fp = path.join(BK, fileOf(t.exam));
    if (!byFile[fp]) {
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      byFile[fp] = { j, arr: Array.isArray(j) ? j : j.questions, added: 0 };
    }
    const { arr } = byFile[fp];
    const seen = new Set(arr.map(q => `${q.exam_code}_${q.subject}_${q.number}`));
    let nextId = Math.max(0, ...arr.map(q => Number(q.id)).filter(Number.isFinite)) + 1;

    for (const [s, subject] of Object.entries(t.papers)) {
      const label = `${t.exam} ${t.code} ${subject}`;
      let paper;
      try {
        const buf = await fetchSheet('Q', t.code, t.c, s);
        if (!buf) { summary.push(`✗ ${label} 抓不到試題卷`); continue; }
        paper = readPaperOptions(mupdf, buf);
      } catch (e) { summary.push(`✗ ${label} 解析失敗 ${e.message}`); continue; }
      if (!paper.ok) { summary.push(`✗ ${label} 認不得選項標記`); continue; }

      const nums = Object.keys(paper.opts).map(Number).sort((a, b) => a - b)
        .filter(n => KEYS.every(k => paper.opts[n][k]));
      if (!nums.length) { summary.push(`✗ ${label} 解不出完整的題`); continue; }

      // ── 答案 ──
      const answers = {};
      let src = '';
      for (const n of nums) {
        const hit = KEYS.find(k => /<\s*正確答案\s*>/.test(paper.opts[n][k].fullRaw));
        if (hit) answers[n] = hit;
      }
      if (Object.keys(answers).length >= nums.length * 0.9) src = '卷上標註';
      else {
        for (const kind of ['S', 'M']) {
          try {
            const b = await fetchSheet(kind, t.code, t.c, s);
            if (!b) continue;
            const m = await parseAnswerSheet(b);
            if (Object.keys(m).length >= nums.length * 0.9) {
              for (const n of nums) if (m[n]) answers[n] = String(m[n]).trim();
              src = kind === 'S' ? '答案卷' : '更正答案卷';
              break;
            }
          } catch { /* 沒有這張 */ }
        }
      }
      if (!src) { summary.push(`✗ ${label} 找不到答案（${nums.length} 題）`); continue; }

      // ── tag 分段 ──
      const tp = tagPlan(arr, subject);
      if (!tp) { summary.push(`✗ ${label} 題庫裡沒有同科目可參照 tag`); continue; }
      /*
       * tag 是照**題號分段**的（1-16 解剖、17-32 生理…），所以兩邊題數差一兩題
       * 不影響分段，只要卷長一樣就行。參照年本身也可能少解出一題
       * （臨床心理師 100030 特論(一) 只有 39 題），所以不能要求題數相等。
       * 卷長差太多才是版型改過，那時套過去會整卷錯位。
       */
      /*
       * 卷上的數字不是只有題號：「206Pb」會被當成第 206 題、聽力圖的頻率
       * 「110」也會。它們後面剛好接得到四個「選項」，所以過不了前面的篩。
       * 參照年告訴我們這張卷有多長，超出的一律丟掉。
       */
      const over = nums.filter(n => n > tp.max + 2);
      const nums2 = nums.filter(n => n <= tp.max + 2);
      if (over.length) summary.push(`   （${label} 丟掉 ${over.length} 個假題號：${over.join(',')}）`);
      nums.length = 0; nums.push(...nums2);
      if (!nums.length) { summary.push(`✗ ${label} 篩掉假題號後沒東西了`); continue; }
      const maxN = nums[nums.length - 1];
      if (Math.abs(tp.max - maxN) > 2) {
        summary.push(`✗ ${label} 卷長 ${maxN} ≠ 參照年 ${tp.from} 的 ${tp.max}，不套 tag`);
        continue;
      }

      const add = [];
      let skipped = 0;
      for (const n of nums) {
        const ans = answers[n];
        if (!ans || !/^[A-D]$/.test(ans)) { skipped++; continue; }   // 「#」送分等
        const key = `${t.code}_${subject}_${n}`;
        if (seen.has(key)) continue;
        const stem = String(paper.stems[n] || '').replace(/\s+/g, ' ').trim();
        if (stem.length < 4) { skipped++; continue; }
        const options = {};
        for (const k of KEYS) options[k] = paper.opts[n][k].fullRaw
          .replace(/<\s*正確答案\s*>/g, '').replace(/\s+/g, ' ').trim();
        /*
         * 四格要互異**而且都不是空的**。只看「互異」擋不住空格
         * ——空字串本身就是一個相異值，於是「A/B/空/D」會過關
         * （核醫 099010 #73 的上標、構音 #78 的 IPA 被字型丟掉，整格變空）。
         */
        if (KEYS.some(k => !options[k])) { skipped++; continue; }
        if (new Set(Object.values(options).map(nz)).size < 4) { skipped++; continue; }
        // 參照年剛好缺這個題號時，往前找最近一題的分段
        let tg = tp.plan[n];
        for (let d = 1; !tg && d <= 4; d++) tg = tp.plan[n - d] || tp.plan[n + d];
        if (!tg) { skipped++; continue; }
        seen.add(key);
        const rec = {
          id: nextId++, roc_year: '99', session: SESSION[t.code], exam_code: t.code,
          subject, subject_tag: tg.tag, subject_name: tg.name, stage_id: tg.stage,
          number: n, question: stem, options, answer: ans, explanation: '',
        };
        /*
         * 題幹提到圖、但圖還沒補 → 先標 incomplete，前端會藏起來。
         * 不標的話一口氣上線就會多出幾百題「提到圖但沒有圖」給使用者看到。
         * 圖之後用 extract-missing-figures.js 補，補到了再把標記拿掉。
         */
        if (needsImage(rec)) rec.incomplete = 'missing_image';
        add.push(rec);
      }
      summary.push(`${add.length ? "✓" : "·"} ${label} ${add.length} 題（答案來源 ${src}，略過 ${skipped}，含圖待補 ${add.filter(x => x.incomplete).length}）`);
      if (APPLY && add.length) { arr.push(...add); byFile[fp].added += add.length; }
    }
  }

  for (const line of summary) console.log(line);
  const tot = Object.values(byFile).reduce((a, b) => a + b.added, 0);
  if (APPLY) {
    for (const [fp, v] of Object.entries(byFile)) {
      if (!v.added) continue;
      if (!Array.isArray(v.j) && v.j.total !== undefined) v.j.total = v.arr.length;
      fs.writeFileSync(fp, JSON.stringify(v.j, null, 2) + '\n');
      console.log(`寫入 ${path.basename(fp)} ＋${v.added} 題`);
    }
  }
  console.log(`\n${APPLY ? '已加' : '可加'} ${APPLY ? tot : summary.filter(l => l.startsWith('✓')).length + ' 卷'}`);
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})();
