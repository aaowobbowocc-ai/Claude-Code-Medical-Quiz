#!/usr/bin/env node
/**
 * 補回被丟掉的題組情境（「情況：……依此回答下列第35 題至第36 題。」）。
 *
 * 考選部有一種題組寫法是獨立一段的「情況：」，後面接「依此回答下列第N題至第M題」。
 * parser 沒有把它當成任何一題的內容，於是那幾題在題庫裡變成無頭的句子：
 *   #35「小美最有可能患下列何種疾患？」—— 小美是誰完全不見了
 * （2026-11-13 使用者回報 臨床心理師 100 第二次 #35「題目不完整」）
 *
 * 作法：從原卷抓「情況：」那一段（到下一個題號為止），解析它宣告的題號範圍，
 * 把整段以【題組情境】的形式接到那幾題的題幹前面 —— 跟其他考試的題組寫法一致。
 *
 * 只在這些條件都成立時才改（寧可不動）：
 *   · 題幹裡還沒有這段情境（比對去空白後的前 20 字）
 *   · 宣告的範圍不超過 6 題
 *   · 這一題的題號確實落在範圍內，而且題庫裡找得到
 *
 *   node scripts/repair-case-context.js [--exam=clinical-psychology] [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];

// 「情況：」「情境：」「案例：」都見過；後面一定接「回答第N題至第M題」的宣告
const CASE_HEAD = /^(情況|情境|案例|題組)\s*[：:]/;
const RANGE = /回答\s*(?:下列)?\s*第\s*(\d{1,3})\s*題\s*(?:至|到|[-~～])\s*第?\s*(\d{1,3})\s*題/;
const norm = s => String(s == null ? '' : s).normalize('NFC')
  .replace(/[\u0080-\u009f­​-‏-�]/g, '')
  .replace(/[\s　]+/g, '');

(async () => {
  const mupdf = await import('mupdf');
  const kill = o => { try { o && o.destroy && o.destroy(); } catch { /* 已釋放 */ } };
  let fixed = 0, blocks = 0;
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

      for (let pg = 0; pg < doc.countPages(); pg++) {
        let pageObj = null, stObj = null, st = null;
        try {
          pageObj = doc.loadPage(pg);
          stObj = pageObj.toStructuredText('preserve-whitespace');
          st = JSON.parse(stObj.asJSON());
        } catch { kill(stObj); kill(pageObj); continue; }
        kill(stObj); kill(pageObj);
        const lines = [];
        for (const b of st.blocks || []) for (const l of b.lines || []) {
          const t = (l.text || '').normalize('NFC').trim();
          if (t) lines.push({ x: l.bbox.x, y: l.bbox.y, t });
        }
        lines.sort((a, b) => a.y - b.y || a.x - b.x);
        for (let i = 0; i < lines.length; i++) {
          if (!CASE_HEAD.test(lines[i].t)) continue;
          // 收到下一個題號行為止
          const parts = [lines[i].t];
          for (let k = i + 1; k < lines.length; k++) {
            const t = lines[k].t;
            if (/^\d{1,3}\s*$/.test(t) || /^\d{1,3}\s*[.．、]/.test(t)) break;
            parts.push(t);
          }
          const text = parts.join('');
          const m = RANGE.exec(text);
          if (!m) { bump('情況段沒有宣告題號範圍'); continue; }
          const from = +m[1], to = +m[2];
          if (to < from || to - from > 5) { bump('宣告的範圍不合理'); continue; }
          blocks++;
          const ctx = text.replace(/^(情況|情境|案例|題組)\s*[：:]\s*/, '').trim();
          for (let n = from; n <= to; n++) {
            const q = items.find(x => +x.number === n);
            if (!q) { bump('題庫沒有這一題'); continue; }
            const head = norm(ctx).slice(0, 20);
            if (norm(q.question).includes(head)) { bump('題幹已經有情境了'); continue; }
            console.log(`${APPLY ? '✓' : '·'} ${exam} ${code} ${subject} #${n}`);
            console.log(`    原: ${String(q.question).replace(/\s+/g, ' ').slice(0, 56)}`);
            console.log(`    補: 【題組情境】${ctx.replace(/\s+/g, ' ').slice(0, 56)}…`);
            if (APPLY) { q.question = `【題組情境】${ctx}\n\n${q.question}`; touched = true; }
            fixed++;
          }
        }
      }
      kill(doc);
    }
    if (APPLY && touched) fs.writeFileSync(path.join(BK, f), JSON.stringify(j, null, 2), 'utf8');
  }
  console.log(`\n${APPLY ? '已補' : '可補'} ${fixed} 題｜掃到 ${blocks} 段情況`);
  if (Object.keys(why).length) console.log('跳過統計:', JSON.stringify(why, null, 1));
})().catch(e => { console.error(e.stack); process.exit(1); });
