#!/usr/bin/env node
/**
 * 以考選部的**更正答案卷**為準，修正題庫的答案；順便清掉沒有佐證的 correction_note。
 *
 * 背景（2026-11-20）：`correction_note` 這個欄位本身就有錯 ——
 * 拿原卷驗 276 筆，91 筆對不上：
 *   · 70 題更正卷寫「一律給分」，題庫卻還是單一字母 → 使用者選別的就被判錯
 *   · 4 題更正卷把答案換了（物治 110020 #61 D→A…），題庫沒跟著改
 *   · 11 筆註記**更正卷根本沒提那一題**（藥師一階 112020 卷一只更正 #46，
 *     註記卻掛在 #25 與 #38；#32「鴉片過量注射什麼」答案是 naloxone，
 *     註記卻說「更正為 A,D」= buprenorphine／methylnaltrexone，明顯不對）
 *
 * 更正卷的備註固定排在 PDF 最後，寫法有幾種：
 *   「第19題答Ｂ或Ｃ或BC者均給分，第43題答Ｂ或Ｄ或BD者均給分」
 *   「第6題，答Ｂ或Ｄ或BD者均給分。 第45題，答Ｃ給分。」
 *   「第46題一律給分」「第29題答Ｂ、Ｃ給分。」
 *
 * 只處理「題庫裡已經有 correction_note」的那些卷 —— 那是我們知道有更正的地方。
 * 要全站掃的話得把每一卷的更正卷都抓一遍，另外再說。
 *
 *   node scripts/apply-official-corrections.js [--exam=pharma1] [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet, pdfText } = require('./lib/moex-paper-resolve');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const onlyExam = arg('exam');
const fileOf = e => (e === 'doctor1' ? 'questions.json' : `questions-${e}.json`);
const FW = { 'Ａ': 'A', 'Ｂ': 'B', 'Ｃ': 'C', 'Ｄ': 'D', 'Ｅ': 'E' };
const half = s => String(s).replace(/[ＡＢＣＤＥ]/g, c => FW[c]);

function parseRemarks(text) {
  const out = {};
  const t = half(String(text || '')).replace(/\s+/g, '');
  const re = /第(\d{1,3})題[，,]?([^第]{0,120}?給分)/g;
  let m;
  while ((m = re.exec(t))) {
    const n = +m[1], body = m[2];
    const letters = [...new Set((body.match(/[A-E]/g) || []))].sort();
    out[n] = letters.length ? letters.join(',') : '送分';
  }
  return out;
}

(async () => {
  const files = {};
  const load = e => files[e] || (files[e] = JSON.parse(fs.readFileSync(path.join(BK, fileOf(e)), 'utf8')));
  const rows = e => { const j = load(e); return Array.isArray(j) ? j : j.questions; };

  // 哪些卷有 correction_note
  const papers = new Set();
  for (const f of fs.readdirSync(BK).filter(x => /^questions(-[a-z0-9-]*)?\.json$/.test(x) && !/\.bak/.test(x))) {
    const e = f === 'questions.json' ? 'doctor1' : f.replace(/^questions-/, '').replace(/\.json$/, '');
    if (onlyExam && e !== onlyExam) continue;
    for (const q of rows(e)) if (q.correction_note) papers.add(`${e}|${q.exam_code}|${q.subject}`);
  }

  const changed = [], reverted = [], unproven = [], touched = new Set();
  for (const key of [...papers].sort()) {
    const [exam, code, subject] = key.split('|');
    const all = rows(exam).filter(q => String(q.exam_code) === code && q.subject === subject);
    let remarks = null;
    try {
      const p = await resolvePaper({ exam, code, year: String(all[0].roc_year), subject, items: all });
      if (p) { const b = await fetchSheet('M', code, p.c, p.s); if (b) remarks = parseRemarks(await pdfText(b)); }
    } catch { /* 沒有更正卷 */ }
    /*
     * 這一卷根本沒有更正答案卷（只有標準答案卷）→ 掛在上面的 correction_note
     * 一定是別處來的。藥師一階 111100 卷一就是這樣：沒有 M 卷，
     * 註記卻說「第47題更正為 C,D」，而且答案已經被改成 C,D 了。
     * 牙醫二階 113090 卷二更明顯 —— 三筆註記寫的是「第56題」「第79題」「第22題」，
     * 全是**卷一**的更正內容掛到卷二來。
     */
    if (!remarks) {
      for (const q of all) {
        if (!q.correction_note || String(q.correction_note).startsWith('⚠')) continue;
        const cur = String(q.answer || ''), orig = q.original_answer;
        if (cur.includes(',') && orig && !String(orig).includes(',')) {
          reverted.push(`${key} #${q.number}  ${cur} → ${orig}（這一卷沒有更正卷）`);
          if (APPLY) { q.answer = String(orig); touched.add(exam); }
        }
        unproven.push(`${key} #${q.number}  這一卷沒有更正卷，註記「${String(q.correction_note).slice(0, 36)}」`);
        if (APPLY) { q.correction_note = `⚠這一卷沒有更正卷：${q.correction_note}`; touched.add(exam); }
      }
      continue;
    }

    // 1) 更正卷說什麼就是什麼
    for (const [nStr, want] of Object.entries(remarks)) {
      const q = all.find(x => +x.number === +nStr);
      if (!q) continue;
      if (String(q.answer) === want) continue;
      changed.push(`${key} #${nStr}  ${q.answer} → ${want}`);
      if (APPLY) {
        if (!q.original_answer) q.original_answer = String(q.answer);
        q.answer = want;
        q.disputed = true;
        q.correction_note = `更正答案卷：第${nStr}題 → ${want}`;
        touched.add(exam);
      }
    }
    // 2) 更正卷沒提、我們卻照註記改過答案的，退回原答案
    for (const q of all) {
      if (!q.correction_note || remarks[+q.number]) continue;
      const cur = String(q.answer || '');
      const orig = q.original_answer;
      if (cur.includes(',') && orig && !String(orig).includes(',')) {
        reverted.push(`${key} #${q.number}  ${cur} → ${orig}（更正卷沒提這一題）`);
        if (APPLY) { q.answer = String(orig); touched.add(exam); }
      }
      unproven.push(`${key} #${q.number}  註記「${String(q.correction_note).slice(0, 36)}」更正卷沒提`);
      if (APPLY) { q.correction_note = `⚠未獲更正卷佐證：${q.correction_note}`; touched.add(exam); }
    }
  }

  console.log(`依更正卷改答案 ${changed.length} 題｜退回原答案 ${reverted.length} 題｜註記沒有佐證 ${unproven.length} 筆`);
  console.log('\n--- 改答案 ---'); changed.slice(0, 200).forEach(s => console.log('   ' + s));
  if (changed.length > 200) console.log(`   …還有 ${changed.length - 200}`);
  if (reverted.length) { console.log('\n--- 退回 ---'); reverted.forEach(s => console.log('   ' + s)); }
  if (unproven.length) { console.log('\n--- 沒有佐證的註記 ---'); unproven.forEach(s => console.log('   ' + s)); }

  if (APPLY) {
    for (const e of touched) fs.writeFileSync(path.join(BK, fileOf(e)), JSON.stringify(files[e], null, 2));
    console.log(`\n✅ 已寫入 ${[...touched].join(', ')}`);
  } else console.log('\n(試跑；加 --apply 才寫入)');
})();
