#!/usr/bin/env node
/**
 * 修「承上題配到別卷的題組情境」。
 *
 * 壞法：同一場次有好幾卷，承上題的情境是用「題號」往回找的，沒有限定在
 * 同一卷之內 —— 於是藥師二階 108100 調劑與臨床 #74「承上題，一個月後王奶奶
 * 來複診」掛上的情境是**藥物治療 #73**「脊椎骨以外部位之骨髓炎」。
 * 題目與選項都沒壞、答案也對，所以既有稽核一條都看不到，但使用者讀到的
 * 情境跟題目完全是兩回事。見 project_followup_questions。
 *
 * 判準（三個條件都要成立才算候選）：
 *   1. 情境文字在**自己這一卷**題號更小的題裡找不到；
 *   2. 卻在同場次**別卷**找得到 → 證明它是借來的；
 *   3. 往回走能在自己卷內找到第一個非承上題的題（lead）。
 *
 * 然後一律回去抓考選部原卷驗兩端（不拿題庫當 ground truth）：
 *   · 原卷該題號確實是這個承上題；
 *   · 原卷 lead 題號確實是這個 lead。
 * 兩端都對得上才改寫情境；對不上就印出來人工看。
 *
 *   node scripts/repair-followup-context.js [--apply] [--exam=pharma2]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { nz, readPaperOptions } = require('./lib/moex-paper-options');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];

const STRIP = /^(?:【題組情境】)+/;
/*
 * 正常是「情境＋空行＋題目」兩段。藥師二階 108030 調劑與臨床 #73 是三段：
 * 【題組情境】被貼兩次＋「承上題，gentamicin loading dose…」＋
 * 「承上題，protein calories…」，前兩段其実是別卷（藥物治療 #71/#72）的。
 * 真正的題目是**最後一段**；中間被丟掉的段落要在篩選時逐段証明是別卷的，
 * 否則不碰 —— 不然題目本身包含空行的正常題會被切掉一半。
 */
const parts = (q) => {
  const s = String(q.question || '');
  if (!s.startsWith('【題組情境】')) return null;
  const seg = s.split('\n\n');
  if (seg.length < 2) return { ctx: seg[0].replace(STRIP, ''), body: '', dropped: [] };
  return { ctx: seg[0].replace(STRIP, ''), body: seg[seg.length - 1], dropped: seg.slice(1, -1) };
};
const pre = (s, n) => nz(s).slice(0, n);

(async () => {
  const mupdf = await import('mupdf');
  const files = fs.readdirSync(BK).filter((f) => /^questions(-.*)?\.json$/.test(f) && !/\.bak/.test(f));
  let cand = 0, fixed = 0, skip = 0;
  const notes = [];

  for (const f of files) {
    const exam = f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '');
    if (only && exam !== only) continue;
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    if (!arr) continue;

    const byPaper = {}, byCode = {};
    for (const q of arr) {
      (byPaper[q.exam_code + '|' + q.subject] = byPaper[q.exam_code + '|' + q.subject] || []).push(q);
      (byCode[q.exam_code] = byCode[q.exam_code] || []).push(q);
    }

    // 候選
    const todo = [];
    for (const q of arr) {
      const p = parts(q);
      if (!p) continue;
      const k = pre(p.ctx, 24);
      if (k.length < 10) continue;
      const mine = byPaper[q.exam_code + '|' + q.subject] || [];
      if (mine.some((x) => x !== q && +x.number < +q.number && nz(x.question).includes(k))) continue;
      if (!(byCode[q.exam_code] || []).some((x) => x.subject !== q.subject && nz(x.question).includes(k))) continue;
      // 中間被丟掉的段落：每一段都要能在同場次別卷找到，才算証明是污染
      const alien = (p.dropped || []).every((d) => {
        const dk = pre(d, 20);
        return dk.length >= 10 && (byCode[q.exam_code] || []).some((x) => x.subject !== q.subject && nz(x.question).includes(dk));
      });
      if (!alien) continue;
      let lead = null;
      for (let n = +q.number - 1; n >= 1 && n >= +q.number - 6; n--) {
        const c = mine.find((x) => +x.number === n);
        if (!c) break;
        if (parts(c)) continue;
        lead = c; break;
      }
      todo.push({ q, p, lead, mine });
    }
    if (!todo.length) continue;
    cand += todo.length;

    const cache = {};
    let dirty = false;
    for (const t of todo) {
      const { q, p, lead, mine } = t;
      const tag = `${exam} ${q.exam_code} ${q.subject} #${q.number}`;
      if (!lead) { skip++; notes.push(`  ⊘ ${tag}：往回走找不到 lead`); continue; }
      const key = q.exam_code + '|' + q.subject;
      if (cache[key] === undefined) {
        cache[key] = null;
        try {
          const pp = await resolvePaper({ exam, code: q.exam_code, subject: q.subject, year: String(q.exam_code).slice(0, 3), items: mine });
          if (pp) cache[key] = readPaperOptions(mupdf, await fetchSheet('Q', q.exam_code, pp.c, pp.s));
        } catch (e) { /* 對不到卷 */ }
      }
      const r = cache[key];
      if (!r || !r.stems) { skip++; notes.push(`  ⊘ ${tag}：對不到官方卷`); continue; }
      const sHere = nz(r.stems[+q.number] || '');
      const sLead = nz(r.stems[+lead.number] || '');
      const kBody = pre(p.body, 12), kLead = pre(lead.question, 12);
      if (kBody.length < 8 || !sHere.includes(kBody)) { skip++; notes.push(`  ⊘ ${tag}：原卷該題號對不上本題題目`); continue; }
      if (kLead.length < 8 || !sLead.includes(kLead)) { skip++; notes.push(`  ⊘ ${tag}：原卷 #${lead.number} 對不上 lead`); continue; }

      const next = '【題組情境】' + String(lead.question).trim() + '\n\n' + p.body;
      if (APPLY) { q.question = next; dirty = true; }
      fixed++;
      console.log(`  ✓ ${tag}`);
      console.log(`      舊情境 ${p.ctx.replace(/\s+/g, ' ').slice(0, 56)}`);
      console.log(`      新情境 #${lead.number} ${String(lead.question).replace(/\s+/g, ' ').slice(0, 56)}`);
    }
    if (APPLY && dirty) fs.writeFileSync(path.join(BK, f), JSON.stringify(j, null, 2) + '\n', 'utf8');
  }

  notes.forEach((n) => console.log(n));
  console.log(`\n候選 ${cand}｜原卷驗過${APPLY ? '已改寫' : '可改寫'} ${fixed}｜驗不過保留 ${skip}`);
})();
