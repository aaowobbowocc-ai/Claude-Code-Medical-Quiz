#!/usr/bin/env node
/**
 * 補鐵路特考（台鐵招考）佐級「國文（包括公文格式用語）」的**複選題**。
 *
 * 這一卷的卷頭自己寫得很清楚：
 *   ※注意：本試題共45 題，其中單選題35 題，複選題10 題
 * 但題庫只有 35 題單選——scrape-railway.js 當初刻意只收單選
 * （`if (!ans || !/^[ABCD]$/.test(ans)) dropped++`），複選那 10 題從來沒進來。
 * exam-configs 的 count 也寫 35，所以缺題盤點看不出來。
 *
 * 兩個前置條件都已經處理掉：
 *   1. 答案卷解析器原本只認 A-D，複選答案「BE」的 E 被吃掉之後剩「B」，
 *      湊巧讓「字母數 = 題號數」成立 → 整列錯位（第41-45題被填成別題的答案、
 *      還多出不存在的第46-50題）。2026-11-27 修好，現在走 lib/moex-answer-sheet。
 *   2. 前端原本不看 is_multi，複選題點一個就判對。已改成要全對才給分。
 *
 * 作法：用同一支 scrape-railway 的版面解析（parseQuestions 傳 maxOpts=5），
 * 只收卷頭宣告的複選題號區間，而且四道檢查全過才寫入：
 *   · 卷頭的複選題數 = 實際解出來的題數
 *   · 每題都有五個選項，且每個都不是空的
 *   · 答案卷給的是多字母（複選才會是 AD / ACE / ABCE）
 *   · 同一張卷上的單選題要對得上題庫裡既有的題幹（確認抓到的是同一卷）
 *
 *   node scripts/fill-railway-multi-select.js            # 試跑
 *   node scripts/fill-railway-multi-select.js --apply
 */
const fs = require('fs');
const path = require('path');
const { fetchSheet, pdfText } = require('./lib/moex-paper-resolve');
const { parseAnswerSheet } = require('./lib/moex-answer-sheet');
const { skeleton } = require('./lib/moex-normalize');
const { atomicWriteJson } = require('./lib/atomic-write');
const S = require('./scrape-railway.js');
/** 有改寫就要寫檔，即使一題都沒新增 */
let touched = false;
const dirty = () => touched;

const BK = path.join(__dirname, '..');
const count = (t, ch) => (String(t || '').split(ch).length - 1);
/** 引號開得比收得多 = 引文還沒收尾（見 project_moex_quote_spill） */
const unclosed = (t) => count(t, '「') - count(t, '」');
const KEYS5 = ['A', 'B', 'C', 'D', 'E'];
const APPLY = process.argv.includes('--apply');
const MAP = JSON.parse(fs.readFileSync(path.join(__dirname, '_railway-map.json'), 'utf8'));

/** 卷頭宣告的結構：共幾題、單選幾題、複選幾題、複選的題號區間 */
function declared(text) {
  const t = text.replace(/\s+/g, '');
  // 同一句話十年換過四種寫法：「本試題共」「本科目共」「共」開頭，
  // 「單選題」與「單一選擇題」兩種叫法。只認一種就會把 103-108 全判成「那年沒考複選」。
  const m = t.match(/共(\d+)題[，,]其中單一?選擇?題(\d+)題[，,]複選題(\d+)題/);
  if (!m) return null;
  const r = t.match(/複選題[（(]第(\d+)題至第(\d+)題/);
  const single = +m[2], multiN = +m[3];
  return {
    total: +m[1], single, multiN,
    from: r ? +r[1] : single + 1,
    to: r ? +r[2] : single + multiN,
  };
}

(async () => {
  const report = [];
  for (const examKey of ['transport', 'admin']) {
    const def = S.EXAMS[examKey];
    const file = path.join(BK, def.file);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = data.questions;
    const seen = new Set(arr.map(q => `${q.exam_code}_${q.subject_tag}_${q.number}`));
    let nextId = arr.length ? Math.max(...arr.map(q => +q.id || 0)) + 1 : 1;
    const added = [];

    for (const roc of Object.keys(MAP).sort()) {
      const ym = MAP[roc];
      const cls = ym[def.cKey];
      if (!cls) continue;
      const s = S.resolveS(cls.subjects, '國文');
      if (!s) { report.push([examKey, roc, '找不到國文的科目代號']); continue; }

      const qBuf = await fetchSheet('Q', ym.sessionCode, cls.c, s);
      if (!qBuf) { report.push([examKey, roc, '抓不到試題卷']); continue; }
      const text = await pdfText(qBuf);
      const d = declared(text);
      if (!d) { report.push([examKey, roc, '卷頭沒宣告複選題（可能那年沒考複選）']); continue; }

      const parsed = S.parseQuestions(S.buildLogicalLines(await S.extractPositionedText(qBuf)), 5);
      const multi = parsed.filter(q => q.number >= d.from && q.number <= d.to);
      if (multi.length !== d.multiN) {
        report.push([examKey, roc, `卷頭說複選 ${d.multiN} 題，實際只解出 ${multi.length} 題（第${d.from}~${d.to}題）`]);
        continue;
      }

      // 身分驗證：同一張卷的單選題要對得上題庫既有的題幹
      const have = arr.filter(q => String(q.exam_code) === ym.sessionCode && q.subject_tag === 'chinese');
      const bank = new Set(have.map(q => skeleton(q.question).slice(0, 18)).filter(x => x.length >= 14));
      const singles = parsed.filter(q => q.number < d.from);
      let hit = 0;
      for (const q of singles) if (bank.has(skeleton(q.question).slice(0, 18))) hit++;
      const rate = bank.size ? hit / bank.size : 0;
      if (bank.size >= 10 && rate < 0.6) {
        report.push([examKey, roc, `這張卷跟題庫對不起來（單選題命中率 ${(rate * 100).toFixed(0)}%）`]);
        continue;
      }

      const sBuf = await fetchSheet('S', ym.sessionCode, cls.c, s);
      const ansAll = sBuf ? await parseAnswerSheet(sBuf) : {};
      const bad = [];
      const rows = [];
      for (const q of multi) {
        const a = String(ansAll[q.number] || '').trim();
        const o = q.options;
        if (!/^[A-E]{2,5}$/.test(a)) { bad.push(`#${q.number} 答案卷給的不是複選答案（${a || '沒有'}）`); continue; }
        if (!KEYS5.every(k => o[k] && o[k].trim())) {
          bad.push(`#${q.number} 選項不滿五個（${KEYS5.filter(k => !o[k]).join('')} 缺）`);
          continue;
        }
        // 引文溢出到選項格的檢查：題幹的「比」多、而某一格把它收掉，
        // 就表示引文被攔腰切斷、後半段填進選項了（真正的選項會被整組擠掉）。
        // 這條訊號零誤報，寧可整年不收也不要收進壞題。
        if (unclosed(q.question) > 0 && KEYS5.some(k => unclosed(o[k]) < 0)) {
          bad.push(`#${q.number} 引文溢出到選項格（第 ${KEYS5.filter(k => unclosed(o[k]) < 0).join('')} 格收引號）`);
          continue;
        }
        // 第二道：提問那一行被切進選項格（選項不會用問號或「…的選項是：」收尾）。
        // 這種的選項整組位移、最後一個還會整個掉出去。
        const PROMPT = /(下列|下述|何者|那一|哪一|為何|請問|選出|符合|正確的|錯誤的|敘述)/;
        const promptCell = KEYS5.filter(k => /[？?]\s*$/.test(String(o[k]).trim())
          || (/[：︰:]\s*$/.test(String(o[k]).trim()) && PROMPT.test(String(o[k]))));
        if (promptCell.length && promptCell.length < 3) {
          bad.push(`#${q.number} 提問被切進選項格（第 ${promptCell.join('')} 格）`);
          continue;
        }
        rows.push({ q, answer: a.split('').join(',') });
      }
      if (bad.length) { report.push([examKey, roc, bad.join('；')]); continue; }

      let kept = 0, updated = 0;
      for (const { q, answer } of rows) {
        const key = `${ym.sessionCode}_chinese_${q.number}`;
        if (seen.has(key)) {
          // 已經收過了（可能是上一版解析收進來的壞題）→ 就地覆寫，**id 不動**
          // （改 id 會讓收藏與錯題夾失聯，見 moex-one-question-rebuild）
          const ex = arr.find(x => String(x.exam_code) === ym.sessionCode
            && x.subject_tag === 'chinese' && +x.number === +q.number);
          if (ex && (ex.question !== q.question || KEYS5.some(k => ex.options[k] !== q.options[k]))) {
            if (APPLY) {
              touched = true;
              ex.question = q.question;
              ex.options = { A: q.options.A, B: q.options.B, C: q.options.C, D: q.options.D, E: q.options.E };
              ex.answer = answer;
              ex.is_multi = true;
              delete ex.incomplete;
            }
            updated++;
          }
          continue;
        }
        seen.add(key);
        added.push({
          id: nextId++, roc_year: roc, session: '第一次', exam_code: ym.sessionCode,
          subject: '國文', subject_tag: 'chinese', subject_name: '國文',
          stage_id: 0, number: q.number,
          question: q.question,
          options: { A: q.options.A, B: q.options.B, C: q.options.C, D: q.options.D, E: q.options.E },
          answer, is_multi: true, explanation: '',
        });
        kept++;
      }
      report.push([examKey, roc, `複選 ${kept} 題新增／${updated} 題改寫（第${d.from}~${d.to}題，單選題命中率 ${(rate * 100).toFixed(0)}%）`]);
    }

    if (added.length || dirty(arr)) {
      console.log(`\n── ${examKey}：${added.length} 題 ──`);
      for (const a of added.slice(0, 3)) {
        console.log(`  ${a.exam_code} #${a.number} 答案 ${a.answer}`);
        console.log(`    ${a.question.slice(0, 70)}`);
        for (const k of ['A', 'B', 'C', 'D', 'E']) console.log(`    ${k}) ${String(a.options[k]).slice(0, 50)}`);
      }
      if (APPLY) {
        arr.push(...added);
        arr.sort((x, y) => String(x.exam_code).localeCompare(String(y.exam_code))
          || String(x.subject_tag).localeCompare(String(y.subject_tag)) || x.number - y.number);
        data.total = arr.length;
        atomicWriteJson(file, data);
        console.log(`  ✅ 寫入 ${def.file}，共 ${arr.length} 題`);
      }
    }
  }

  console.log('\n── 逐年 ──');
  for (const r of report) console.log(`  ${r[0].padEnd(10)} ${r[1]}  ${r[2]}`);
  if (!APPLY) console.log('\n(試跑；加 --apply 才寫入)');
})();
