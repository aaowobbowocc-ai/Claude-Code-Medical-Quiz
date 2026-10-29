#!/usr/bin/env node
/**
 * 補回英文選項裡掉掉的空格（「TheIntelligence of Human Beings.」）。
 *
 * 成因：考選部 PDF 的一列是好幾個 text run，空格就在 run 的邊緣
 * （"The" + " Intelligence of Human Beings. "）。解析器把每段 trim 再接起來，
 * 空格就消失了。lib/moex-marker-options.js 的 keep() 已經修在源頭，
 * 但題庫裡既有的 87 題（2026-10-29 清點）要回頭補。
 *
 * **判準是字元等同，不是猜斷詞位置**：
 *   只有在「原卷選項去掉所有空白 === 題庫選項去掉所有空白」，
 *   而且原卷的空白比較多時才換。所以這支腳本只會**加空格**，
 *   不可能改到任何文字內容。不滿足就原封不動並列出來。
 *
 * 只處理不含中日韓文字的選項：中文不用空格分詞，補進去是錯的。
 *
 * ⚠️ **偵測器會大量誤報，這是刻意的。**
 *    GLUE 的簽章（小寫小寫+大寫+小寫小寫）會抓到一堆本來就這樣拼的
 *    專有名詞與商品名：MacConkey、HemeSelect、HemeQuant、MonoSlide、
 *    Paul-Bunnel…。2026-10-29 清點 80 題「疑似黏字」，實際只有 3 題是真的。
 *    不要靠偵測器的數字判斷嚴重性 —— 真正的判準是「原卷同一個選項有空格」。
 *    偵測寬、判定嚴，誤報會自己在「無法處理」裡落地，不會改壞任何東西。
 *
 *   node scripts/repair-option-glue.js [--exam police] [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { markerOptions } = require('./lib/moex-marker-options');
const { paperQuestions } = require('./fill-civil-gaps');
const { atomicWriteJson } = require('./lib/atomic-write');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
// 兩種寫法都接受：--exam=police 與 --exam police
const ei = process.argv.indexOf('--exam');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1]
  || (ei > 0 ? process.argv[ei + 1] : null) || null;
const KEYS = ['A', 'B', 'C', 'D', 'E'];
const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;
/** 黏字簽章：小寫字母後面緊接大寫再接小寫（theIntelligence）。 */
const GLUE = /[a-z]{2}[A-Z][a-z]{2}/;
/** 本來就這樣寫的專有名詞，不是黏字。 */
const CAMEL = /\b(iPhone|iPad|iPod|eBay|YouTube|PowerPoint|JavaScript|McDonald|DNase|RNase|pH|mRNA|tRNA|rRNA)\b/;

const nospace = t => String(t).replace(/\s+/g, '');
const spaces = t => (String(t).match(/\s/g) || []).length;

function glued(t) {
  const s = String(t || '');
  if (!s || CJK.test(s)) return false;
  return GLUE.test(s.replace(CAMEL, ''));
}

/** 掃出所有「選項帶黏字」的題。 */
function targets() {
  const out = [];
  for (const f of fs.readdirSync(BK).filter(n => /^questions.*\.json$/.test(n))) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')); } catch { continue; }
    const arr = Array.isArray(j) ? j : j.questions;
    if (!Array.isArray(arr)) continue;
    // 醫師一階是 questions.json 無後綴，用 questions-* 的 glob 會整個漏掉
    const exam = f === 'questions.json' ? 'doctor1' : f.replace(/^questions-/, '').replace(/\.json$/, '');
    if (only && exam !== only) continue;
    for (const q of arr) {
      if (!q || !q.options || !q.exam_code) continue;
      if (!KEYS.some(k => glued(q.options[k]))) continue;
      out.push({ file: f, exam, code: String(q.exam_code), subject: q.subject, id: q.id, n: Number(q.number) });
    }
  }
  return out;
}

(async () => {
  const rows = targets();
  const groups = {};
  for (const r of rows) (groups[`${r.exam}|${r.code}|${r.subject}`] = groups[`${r.exam}|${r.code}|${r.subject}`] || []).push(r);
  console.log(`選項有黏字的題：${rows.length} 題，分布在 ${Object.keys(groups).length} 卷\n`);

  const banks = {}, fixed = [], left = [];
  for (const key of Object.keys(groups)) {
    const [exam, code, subject] = key.split('|');
    const f = groups[key][0].file;
    if (!banks[f]) { const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')); banks[f] = { raw: j, arr: Array.isArray(j) ? j : j.questions }; }
    const items = banks[f].arr.filter(q => String(q.exam_code) === code && q.subject === subject);
    // 兩個解析器都試：markerOptions 靠 PUA 標記的幾何位置，醫事類那種
    // 用「9. / A.」文字標籤的卷它抓不到題號（實測 53 題解析不到）；
    // paperQuestions 走另一套版型判斷，兩邊互補。
    let mo = null, pq = null;
    try {
      const p = await resolvePaper({ exam, code, subject, year: code.slice(0, 3), items });
      if (!p) { groups[key].forEach(r => left.push({ ...r, why: '對不到官方卷' })); continue; }
      const buf = await fetchSheet('Q', code, p.c, p.s);
      if (!buf) { groups[key].forEach(r => left.push({ ...r, why: '抓不到試題 PDF' })); continue; }
      try { mo = await markerOptions(buf); } catch { /* 這張卷沒有 PUA 標記 */ }
      try { pq = await paperQuestions(code, p.c, p.s); } catch { /* 換另一個來源 */ }
      if (!mo && !pq) { groups[key].forEach(r => left.push({ ...r, why: '兩個解析器都解不開這張卷' })); continue; }
    } catch (e) { groups[key].forEach(r => left.push({ ...r, why: '原卷處理失敗: ' + e.message.slice(0, 40) })); continue; }

    for (const r of groups[key]) {
      const q = banks[f].arr.find(x => String(x.id) === String(r.id));
      const cands = [mo, pq].filter(Boolean).map(m => m.get(r.n) || m.get(String(r.n))).filter(Boolean);
      if (!q || !cands.length) { left.push({ ...r, why: '原卷解析不到該題號' }); continue; }
      const hits = [];
      for (const k of KEYS) {
        const mine = String(q.options[k] || '');
        if (!mine) continue;
        // 只加空格：字元必須完全相同，且原卷的空白比較多。
        // 兩個來源都看，取空白最多的那個（也就是最沒把 PDF 空白吃掉的）。
        let best = null;
        for (const s of cands) {
          const theirs = String((s.options || {})[k] || '');
          if (!theirs || nospace(mine) !== nospace(theirs)) continue;
          if (spaces(theirs) <= spaces(mine)) continue;
          if (!best || spaces(theirs) > spaces(best)) best = theirs;
        }
        if (best) hits.push({ k, from: mine, to: best.replace(/\s+/g, ' ').trim() });
      }
      if (!hits.length) { left.push({ ...r, why: '原卷同一個選項也是黏的（或字元對不上）' }); continue; }
      fixed.push({ ...r, hits });
      if (APPLY) for (const h of hits) q.options[h.k] = h.to;
    }
  }

  console.log(`可補空格 ${fixed.length} 題（共 ${fixed.reduce((n, r) => n + r.hits.length, 0)} 個選項），無法處理 ${left.length} 題\n`);
  for (const r of fixed) {
    console.log(`  ✓ ${r.exam} ${r.code} #${r.n}`);
    for (const h of r.hits) console.log(`      ${h.k}. ${h.from.slice(0, 60)}\n       → ${h.to.slice(0, 60)}`);
  }
  const byWhy = {}; left.forEach(r => (byWhy[r.why] = (byWhy[r.why] || 0) + 1));
  if (left.length) { console.log('\n無法處理:'); Object.entries(byWhy).sort((a, b) => b[1] - a[1]).forEach(([w, n]) => console.log(`  ${n} 題 — ${w}`)); }
  fs.writeFileSync(path.join(BK, '_tmp', 'option-glue-plan.json'), JSON.stringify({ fixed, left }, null, 1), 'utf8');

  if (APPLY) {
    const files = new Set(fixed.map(r => r.file));
    for (const f of files) atomicWriteJson(path.join(BK, f), banks[f].raw);
    console.log(`\n已寫回 ${files.size} 個題庫檔`);
  } else console.log('\n(試跑；加 --apply 才寫入)');
})().catch(e => { console.error(e.stack); process.exit(1); });
