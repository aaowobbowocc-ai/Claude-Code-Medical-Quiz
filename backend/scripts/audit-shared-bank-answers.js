#!/usr/bin/env node
/**
 * 用考選部標準答案卷整卷比「共用題庫」（shared-banks/）的答案。
 *
 * 為什麼要單獨做一支：2026-09-19 那輪全站答案稽核走的是帶 `exam_code` 的卷
 * （[[procedure_answer_audit_sitewide]]），**共用題庫一題都沒被涵蓋到**，
 * 而它們正好都是同一批爬蟲抓的——那批的 `parseAnswers()` 是「把第N題標籤刪掉、
 * 再照閱讀順序把字母配上去」。考選部有些答案卷的「第13題」標籤在文字流裡被排到
 * 第40題後面，於是**從第 12 題起整批位移一格**。普考行政學／行政法實測每一卷都這樣。
 *
 * 正確做法是 moex-answer-geo 的座標配對（題號在上、答案在正下方）。
 *
 * 防呆：題幹要逐題號對得上原卷，否則「答案不同」可能只是題號編法不同。
 * 注意這裡**不能**照搬 procedure_answer_audit_sitewide 的「答案卷配對數 = 題數」那道門檻——
 * 共用題庫本來就只收原卷的一部分（「法學知識與英文」50 題被拆進憲法／法緒／英文三個 bank），
 * 套上去會把 law_knowledge、law_basics 整批跳過。逐題的題幹比對已經是更強的防線。
 *
 *   node scripts/audit-shared-bank-answers.js [--bank common_politics] [--apply]
 */
const fs = require('fs');
const path = require('path');
const { paperQuestions } = require('./fill-civil-gaps');
const { sheetMap } = require('./lib/moex-answer-geo');
const { skeleton } = require('./lib/moex-normalize');
const { atomicWriteJson } = require('./lib/atomic-write');

// 卷別表一律從當初抓它的爬蟲 require 進來，不要在這裡重抄
const politics = require('./scrape-civil-politics');
const localgov = require('./scrape-civil-localgov');
const sharedBanks = require('./scrape-civil-shared-banks');
const old100 = require('./scrape-civil-junior-100-105');
const puagaps = require('./fill-civil-junior-puagaps');
const juniorAdmin = require('./scrape-civil-junior-admin');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const onlyBank = (process.argv.find(a => a.startsWith('--bank=')) || '').split('=')[1];

/** 組出 [{bank, year, code, c, s}]，來源全是爬蟲匯出的表 */
function buildPapers() {
  const out = [];
  for (const s of politics.SESSIONS) out.push({ bank: 'common_politics', year: s.year, code: s.code, c: '401', s: s.s });
  for (const s of localgov.SESSIONS) out.push({ bank: 'common_local_gov', year: s.year, code: s.code, c: '402', s: s.s });
  for (const s of sharedBanks.LAW_KNOWLEDGE_SESSIONS) out.push({ bank: 'common_law_knowledge', year: s.year, code: s.code, c: s.c, s: s.s, sourceCode: s.sourceCode || 'civil-junior-general' });
  for (const s of sharedBanks.LAW_BASICS_SESSIONS) out.push({ bank: 'common_law_basics', year: s.year, code: s.code, c: s.c, s: s.s, sourceCode: s.sourceCode || null });
  // 100-105 backfill：TARGETS = [bank, 科目名, tag, [[year, code, c, s], …]]
  for (const [bank, , , sessions] of old100.TARGETS)
    for (const [year, code, c, s] of sessions) out.push({ bank, year, code, c, s });
  // 普考 行政學概要／行政法概要 106-114（這兩個題庫的答案位移就是在這裡被抓到的）
  for (const ses of juniorAdmin.SESSIONS)
    for (const [bankKey, bank] of [['admin_studies', 'common_admin_studies_junior'], ['admin_law', 'common_admin_law_junior']]) {
      const sub = juniorAdmin.SUBJECTS.find(x => x.bank === bankKey && (!x.onlyYears || x.onlyYears.includes(ses.year)));
      if (sub) out.push({ bank, year: ses.year, code: ses.code, c: sub.c, s: sub.s });
    }
  // 補題腳本的 CONFIGS 補上其餘卷別（公共管理概要等）
  for (const [bank, cfg] of Object.entries(puagaps.CONFIGS))
    for (const t of cfg.targets || []) out.push({ bank, year: t.year, code: t.code, c: t.c, s: t.s, sourceCode: cfg.sourceCode });
  // 同一張卷可能被兩張表都列到，去重
  const seen = new Set();
  return out.filter(p => {
    const k = `${p.bank}|${p.year}|${p.code}|${p.c}|${p.s}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

module.exports = { buildPapers };

if (require.main === module) (async () => {
  const papers = buildPapers().filter(p => !onlyBank || p.bank === onlyBank);
  console.log(`要比對 ${papers.length} 張卷\n`);

  const banks = {}, diffs = [], rows = [];
  let errs = 0;
  for (const p of papers) {
    const file = path.join(BK, 'shared-banks', p.bank + '.json');
    if (!fs.existsSync(file)) continue;
    if (!banks[file]) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      banks[file] = { raw, arr: Array.isArray(raw) ? raw : raw.questions, dirty: false };
    }
    // 同一年可能有好幾張來源卷（法學知識與英文在地方特考／原民特考／高考都考），
    // 只比對這張卷自己的題，否則會拿 A 卷的答案去比 B 卷的題。
    const items = banks[file].arr.filter(q => String(q.roc_year) === String(p.year)
      && (!p.sourceCode || q.source_exam_code === p.sourceCode));
    if (!items.length) continue;
    const rec = { bank: p.bank, year: p.year, have: items.length, ok: 0, diff: 0, noStem: 0 };
    try {
      const src = await paperQuestions(p.code, p.c, p.s);
      const sheet = await sheetMap(p.code, p.c, p.s, items.length);
      rec.sheet = `${sheet.map.size} (${sheet.mode})`;
      // 不要用「答案卷配對數 = 題數」當門檻：共用題庫本來就只收原卷的一部分
      // （「法學知識與英文」50 題被拆進憲法／法緒／英文三個 bank），硬比會整批跳過。
      // 真正的防線是下面逐題的題幹比對——題號＋題幹都對上才動答案。
      if (!sheet.map.size) { rec.why = '答案卷解析不出任何答案，整卷跳過'; rows.push(rec); console.log(`${p.bank} ${p.year} — ${rec.why}`); continue; }
      for (const q of items) {
        const n = +q.number;
        const s = src.get(n);
        const official = sheet.map.get(n);
        if (!official || !s) { rec.noStem++; continue; }
        const a = skeleton(q.question), b = skeleton(s.stem || '');
        if (!a || !b || !(a.startsWith(b.slice(0, 18)) || b.startsWith(a.slice(0, 18)))) { rec.noStem++; continue; }
        if (q.answer === official) { rec.ok++; continue; }
        rec.diff++;
        diffs.push({ bank: p.bank, year: p.year, n, id: q.id, old: q.answer, neu: official,
          q: String(q.question).replace(/\s+/g, ' ').slice(0, 40) });
        if (APPLY) { q.answer = official; banks[file].dirty = true; }
      }
    } catch (e) { errs++; rec.why = '原卷處理失敗: ' + e.message.slice(0, 40); }
    rows.push(rec);
    console.log(`${p.bank} ${p.year} → 相符 ${rec.ok}、不符 ${rec.diff}、對不上 ${rec.noStem}${rec.why ? ' — ' + rec.why : ''}`);
  }

  console.log(`\n答案與官方不符：${diffs.length} 題；原卷處理失敗 ${errs} 卷`);
  fs.writeFileSync(path.join(BK, '_tmp', 'shared-bank-answer-audit.json'), JSON.stringify({ rows, diffs }, null, 1), 'utf8');
  if (APPLY) {
    let n = 0;
    for (const f of Object.keys(banks)) if (banks[f].dirty) { atomicWriteJson(f, banks[f].raw); n++; }
    console.log(`已寫回 ${n} 個共用題庫`);
  } else console.log('(試跑；加 --apply 才寫入)');
})().catch(e => { console.error(e.stack); process.exit(1); });
