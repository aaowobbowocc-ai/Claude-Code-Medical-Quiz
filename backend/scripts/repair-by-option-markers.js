#!/usr/bin/env node
/**
 * 用考選部 PDF 的「選項標記」重建題幹與選項。
 *
 * 關鍵：試題 PDF 的每個選項開頭都帶 PUA 標記 U+E18C/E18D/E18E/E18F = Ⓐ/Ⓑ/Ⓒ/Ⓓ。
 * 標記本身就標明了是第幾個選項，所以不必靠 x/y 座標猜順序——後者在雙欄版型會
 * 整組轉一格，也切不開「題幹尾巴黏進選項A」這種位移（project_option_shift 那
 * ~1,096 題難版型就是卡在這裡）。
 *
 * 只在「我們的題幹是原卷題幹的開頭」時才覆寫，避免題號錯位的卷被亂改。
 * 選項換掉後答案字母可能也跟著錯位，所以答案一律重新從標準答案卷取，
 * 取不到可信答案就不動這一題。
 *
 *   node scripts/repair-by-option-markers.js [--exam speech-therapist] [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper } = require('./lib/moex-paper-resolve');
const { answerMap } = require('./lib/moex-answer-geo');
const { skeleton } = require('./lib/moex-normalize');
const { paperQuestions } = require('./fill-civil-gaps');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];
const flat = s => skeleton(String(s || ''));

(async () => {
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f));
  let tFix = 0, tSame = 0, tSkip = 0, tPapers = 0, errs = 0;
  for (const f of files) {
    const exam = f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '');
    if (only && exam !== only) continue;
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions; if (!arr) continue;
    const g = {};
    for (const q of arr) { if (!q.exam_code) continue; const k = q.exam_code + '|' + q.subject; (g[k] = g[k] || []).push(q); }
    let touched = false;
    for (const k of Object.keys(g)) {
      const [code, ...rest] = k.split('|'); const subject = rest.join('|');
      const items = g[k];
      let p, qs, am;
      try {
        p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items });
        if (!p) continue;
        qs = await paperQuestions(code, p.c, p.s);
        if (qs.size < items.length * 0.5) continue;           // 標記解析不出來就別動
        am = await answerMap(code, p.c, p.s, Math.max(items.length, qs.size), p.subject);
      } catch (e) {
        // 不要靜默吞掉。跑完整批時 mupdf 會資源耗盡，之後每一卷都拋例外，
        // 如果只是 continue，整個字母後段（rt/speech/tcm/vet…）會無聲消失，
        // 而總結還是印得漂漂亮亮。實測就這樣漏掉了一半的考試。
        errs++; console.error(`  ! ${exam} ${code} ${subject}: ${String(e.message).slice(0, 60)}`);
        continue;
      }
      // 整卷題號對齊率：我們的題幹必須是原卷同題號題幹的開頭
      let align = 0, tot = 0;
      for (const it of items) {
        const s = qs.get(+it.number); if (!s) continue; tot++;
        if (flat(s.stem).startsWith(flat(it.question).slice(0, 14))) align++;
      }
      if (!tot || align / tot < 0.8) continue;
      let fix = 0, same = 0, skip = 0, lost = 0, bad = 0;
      for (const it of items) {
        const s = qs.get(+it.number); if (!s) { skip++; continue; }
        const ourStem = flat(it.question), srcStem = flat(s.stem);
        if (!srcStem.startsWith(ourStem.slice(0, 14))) { skip++; continue; }
        const ourOpts = ['A', 'B', 'C', 'D'].map(x => flat((it.options || {})[x] || ''));
        const srcOpts = ['A', 'B', 'C', 'D'].map(x => flat(s.options[x] || ''));
        if (srcOpts.some(o => !o)) { skip++; continue; }
        if (ourStem === srcStem && ourOpts.join('|') === srcOpts.join('|')) { same++; continue; }
        // 只處理一種明確的損壞：**題幹尾巴被切進選項 A**（我們的 題幹+選項A
        // 恰好是原卷題幹的開頭）。這是語言治療師/聽力師那批的 signature。
        // 不設限地重建其他差異會出事——實測 nursing 會把下一題的情境黏進最後
        // 一個選項、nutrition 會把下標壓平成「維生素BB1」還連帶改錯答案，
        // lawyer1 則只是空白差異、重寫毫無意義。
        const merged = ourStem + ourOpts[0];
        if (!(ourStem.length < srcStem.length && srcStem.startsWith(merged.slice(0, Math.min(merged.length, srcStem.length))))) { skip++; continue; }
        // 重建後的最後一個選項若黏到下一題（出現情境語或下一題題號）就不要
        if (/情況|承上題|請依下文|回答第\s*\d+\s*題/.test(String(s.options.D || ''))) { skip++; continue; }
        // 答案怎麼決定：
        //  a) 選項「集合」沒變（只是順序/格式不同）→ 用選項文字把舊答案對應到新位置。
        //     舊答案是既有資料（很多已人工核對過），能保就保，不要平白換成答案卷的。
        //  b) 選項內容真的變了（題幹尾巴歸位、兩個選項被拆開）→ 舊字母已失效，
        //     只能改用標準答案卷；取不到就不動這一題。
        let ans = null;
        const ourText = String((it.options || {})[it.answer] || '').trim();
        const sameSet = [...ourOpts].sort().join('|') === [...srcOpts].sort().join('|');
        if (sameSet && ourText) {
          const k2 = ['A', 'B', 'C', 'D'].find(x => flat(s.options[x]) === flat(ourText));
          if (k2) ans = k2;
        }
        if (!ans) ans = am && am.map.get(+it.number);
        if (!ans) { skip++; continue; }
        // 有些卷的圈圈數字是私有造字，文字抽取會整個消失（100090 #21 的 ⑦ 就是，
        // 題幹變成「⑥嬰幼兒時期營養失調鉛中毒」兩項黏一起）。這種情況重建會把
        // 資料弄丟，寧可不動。判準：新資料的圈圈數字種類不得少於舊資料。
        const circ = t => new Set(String(t).match(/[①-⑳]/g) || []);
        const oldC = circ(Object.values(it.options || {}).join('') + it.question);
        const newC = circ(Object.values(s.options).join('') + s.stem);
        if ([...oldC].some(c => !newC.has(c))) { lost++; skip++; continue; }
        // 原卷題幹常把圖/表的文字一起帶進來（聽力圖的座標標籤、人口表的欄位名）。
        // 考選部的題幹一定以 ？：。 結尾，所以在最後一個句尾標點截斷就能把圖表雜訊切掉。
        // 含圖題不該被文字化（feedback_image_questions_verbatim）。
        const cutStem = (t) => {
          const m = /^[\s\S]*[？?：:。]/.exec(String(t));
          return m ? m[0].trim() : String(t).trim();
        };
        // 寫入前驗收重建結果。標記解析在部分版型會塌掉：四個選項變成一模一樣、
        // 圈圈數字被壓成 ①①①、或殘留 PUA。這種結果比原本的壞資料更糟。
        const newOpts = [s.options.A, s.options.B, s.options.C, s.options.D].map(x => String(x || '').trim());
        if (new Set(newOpts.map(x => x.replace(/\s+/g, ''))).size < 4) { bad++; skip++; continue; }
        if (newOpts.some(x => x.length < 1)) { bad++; skip++; continue; }
        if (/[-]/.test(newOpts.join('') + s.stem)) { bad++; skip++; continue; }
        if (APPLY) {
          it.question = cutStem(s.stem);
          it.options = { A: s.options.A, B: s.options.B, C: s.options.C, D: s.options.D };
          it.answer = ans;
          if (it.incomplete && /broken_options|option_order_unverified|truncated/.test(it.incomplete)) delete it.incomplete;
          touched = true;
        }
        fix++;
      }
      if (fix) { tPapers++; console.log(`${exam} ${code} ${subject}: 對齊 ${(100*align/tot).toFixed(0)}%，原本相同 ${same}，${APPLY ? '已重建' : '可重建'} ${fix}，跳過 ${skip}${lost ? `（${lost} 圈圈數字遺失）` : ''}${bad ? `（${bad} 重建結果不合格）` : ''}`); }
      tFix += fix; tSame += same; tSkip += skip;
    }
    if (APPLY && touched) fs.writeFileSync(path.join(BK, f), JSON.stringify(j, null, 2), 'utf8');
  }
  console.log(`\n${tPapers} 卷 | 原本相同 ${tSame} | ${APPLY ? '已重建' : '可重建'} ${tFix} | 跳過 ${tSkip}`);
})().catch(e => { console.error(e.stack); process.exit(1); });
