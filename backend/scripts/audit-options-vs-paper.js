#!/usr/bin/env node
/**
 * 逐題把題庫的四個選項跟考選部原卷對一次。
 *
 * 為什麼需要：既有的稽核都是「看題庫自己有沒有破綻」——選項重複、中間有洞、
 * PUA 豆腐字。但有一整類壞法在題庫裡**長得完全正常**，只有跟原卷並排才看得到：
 *   · 整組輪轉：聽語 101110 基礎言語科學 #5 題庫 A=2 B=3 C=5 D=1，原卷是 1/2/3/5
 *   · 選項根本是別題的：同卷 #70 題庫寫的是兒童詞彙評量，原卷是「②④⑧⑩」
 *   · 選項字首黏著一個 A／B：#62「A吸氣儲備容積…」#68「B外肋間肌…」
 *   · 選項尾巴吞掉下一段情境：#69 D 後面接著「情況：根據下圖，請回答第70 題…」
 *   · 題庫寫 (圖)、原卷其實是圈號選項：#73/#75/#76/#77
 * 這些全部不會被 health-report 報出來，答案卻可能整題錯。
 *
 * 判準刻意只用「原卷那一行是不是題庫選項的開頭」：
 *   選項換行、斷成好幾段都不影響前綴比對，所以誤報極低；
 *   而題庫被截斷（開頭對、尾巴少）這一類交給 repair-line-merge-truncation，
 *   這裡不管，否則兩支工具會互相打架。
 *
 *   node scripts/audit-options-vs-paper.js [--exam=speech-therapist] [--code=101110]
 *   node scripts/audit-options-vs-paper.js --json out.json
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
// 原卷的解析跟 repair-options-from-paper 共用同一支，兩邊各寫一份的話
// 「稽核報出來的筆數」跟「修復工具認得的筆數」一定會對不上。
const { nz, readPaperOptions } = require('./lib/moex-paper-options');

const BK = path.join(__dirname, '..');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];
const onlyCode = (process.argv.find(a => a.startsWith('--code=')) || '').split('=')[1];
const jsonOut = (process.argv.find(a => a.startsWith('--json=')) || '').split('=')[1];

(async () => {
  const mupdf = await import('mupdf');
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f));
  const rows = [];
  const why = {};
  const bump = (k, n = 1) => { why[k] = (why[k] || 0) + n; };
  let checked = 0, papers = 0;
  const byMode = {};

  for (const f of files) {
    const exam = f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '');
    if (only && exam !== only) continue;
    if (exam === 'gsat' || exam === 'ast') continue;            // 大考中心不是考選部的卷
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions; if (!arr) continue;

    const groups = {};
    for (const q of arr) {
      if (onlyCode && String(q.exam_code) !== onlyCode) continue;
      (groups[q.exam_code + '|' + q.subject] = groups[q.exam_code + '|' + q.subject] || []).push(q);
    }
    for (const key of Object.keys(groups)) {
      const [code, ...rest] = key.split('|');
      const subject = rest.join('|');
      const items = groups[key];
      let parsed;
      try {
        const p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items });
        if (!p) { bump('對不到官方卷'); continue; }
        const buf = await fetchSheet('Q', code, p.c, p.s);
        if (!buf) { bump('抓不到試題卷'); continue; }
        parsed = readPaperOptions(mupdf, buf);
      } catch { bump('取卷失敗'); continue; }
      if (!parsed || !parsed.ok) { bump('認不得選項標記'); continue; }
      papers++;
      byMode[parsed.mode] = (byMode[parsed.mode] || 0) + 1;
      const pdf = parsed.opts, stems = parsed.stems;

      for (const q of items) {
        const got = pdf[+q.number]; if (!got) { bump('原卷找不到這一題'); continue; }
        const bank = q.options || {};
        const bad = [];
        for (const k of ['A', 'B', 'C', 'D']) {
          const head = nz(got[k] && got[k].raw);
          if (head.length < 2) continue;              // 原卷那一行太短，不足以判定
          const mine = nz(bank[k]);
          checked++;
          if (mine.startsWith(head)) continue;
          // 輪轉／錯位：原卷這個字母的開頭其實是題庫別的字母
          const elsewhere = ['A', 'B', 'C', 'D'].find(o => o !== k && nz(bank[o]).startsWith(head));
          bad.push({ k, head, mine, elsewhere: elsewhere || null });
        }
        if (!bad.length) continue;
        /*
         * 先問一個更基本的問題：這個題號在原卷上**是不是同一題**？
         * 不先分這一刀的話，「題庫這題的選項壞了」與「題庫這題整個排錯位置／
         * 對到別張卷」會混在一起 —— 前者可以照原卷修，後者照著修會把好題蓋掉。
         * 判準用題幹開頭 10 個字互為子字串（題幹被截斷、被加情境前綴都還對得上）。
         */
        const bStem = nz(String(q.question || '').replace(/^【題組情境】/, '')).slice(0, 10);
        const pStem = nz(stems[+q.number] || '');
        const stemOk = bStem.length >= 6 && pStem.length >= 6
          && (pStem.includes(bStem) || nz(q.question).includes(pStem.slice(0, 10)));
        // 分類
        let kind = stemOk ? '選項文字與原卷不符' : '題號對不上(題幹也不符)';
        if (!stemOk) { rows.push({ exam, code, subject, number: +q.number, incomplete: q.incomplete || null, kind, bad }); continue; }
        // 四個都不一樣、而且彼此毫無包含關係 → 題庫這一題的選項整組是**別題的**
        //（聽語 100090 神經性溝通障礙學 #21 實測：四個選項跟原卷完全無關）。
        const alien = bad.length === 4 && bad.every(b =>
          !b.elsewhere && !b.mine.includes(b.head) && !b.head.includes(b.mine) && b.mine.length >= 4);
        if (bad.length >= 3 && bad.every(b => b.elsewhere)) kind = '四個選項整組錯位';
        else if (alien) kind = '選項整組是別題的';
        else if (bad.every(b => /^\(圖\)$|^$/.test(b.mine))) kind = '題庫寫 (圖)、原卷是文字';
        else if (bad.every(b => /^[A-Da-d]/.test(b.mine) && b.mine.slice(1).startsWith(b.head))) kind = '選項字首多一個字母';
        else if (bad.every(b => b.head.startsWith(b.mine))) kind = '題庫選項被截斷';
        else if (bad.every(b => b.mine.includes(b.head))) kind = '選項前面多了一段';
        rows.push({ exam, code, subject, number: +q.number, incomplete: q.incomplete || null, kind, bad });
      }
    }
  }

  const byKind = {};
  for (const r of rows) {
    const k = r.kind; (byKind[k] = byKind[k] || []).push(r);
  }
  console.log(`對過 ${papers} 卷、${checked} 個選項，發現 ${rows.length} 題不符`);
  console.log('版型:', JSON.stringify(byMode), '\n');
  for (const k of Object.keys(byKind).sort((a, b) => byKind[b].length - byKind[a].length)) {
    const list = byKind[k];
    const per = {};
    for (const r of list) per[r.exam] = (per[r.exam] || 0) + 1;
    console.log(`■ ${k}  ${list.length} 題  ` +
      Object.entries(per).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([e, n]) => `${e} ${n}`).join('、'));
    for (const r of list.slice(0, 6)) {
      console.log(`   ${r.exam} ${r.code} ${r.subject} #${r.number}` + (r.incomplete ? ` [${r.incomplete}]` : ''));
      for (const b of r.bad.slice(0, 4)) {
        console.log(`     ${b.k} 原卷「${b.head.slice(0, 40)}」 題庫「${b.mine.slice(0, 40)}」` +
          (b.elsewhere ? `（題庫的 ${b.elsewhere}）` : ''));
      }
    }
    if (list.length > 6) console.log(`   …還有 ${list.length - 6} 題`);
  }
  console.log('\n略過:', JSON.stringify(why, null, 1));
  if (jsonOut) { fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 1)); console.log('明細寫到', jsonOut); }
})();
