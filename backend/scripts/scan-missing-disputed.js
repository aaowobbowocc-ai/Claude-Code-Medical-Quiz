#!/usr/bin/env node
/**
 * 掃出「考選部有發更正答案（多答案給分／一律給分），但我們沒標 disputed」的題。
 *
 * 為什麼重要：這類題本質上沒有唯一答案。使用者看到「答案 A、解說卻在論證 B」
 * 會以為答案錯了，但真相是考選部 A、B 都給分，AI 解說挑了單一最佳解來解釋。
 * 2026-09-15 分析「解說與答案矛盾」2,180 筆時發現，抽樣中 77 筆「答案正確」
 * 裡有 74 筆屬於此類——也就是說這才是使用者大量回報「答案有誤」的真正來源。
 *
 * 正確處置不是改答案、也不是重寫解說，而是**標成爭議題**讓使用者一眼看出
 * 「本題官方放寬給分」。專案本來就有 disputed 欄位與前端徽章。
 *
 * 用法：
 *   node scripts/scan-missing-disputed.js --exam doctor1
 *   node scripts/scan-missing-disputed.js --exam doctor1 --apply   # 標記 disputed
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { fetchPdf, buildMoexUrl } = require('./lib/pdf-fetcher');
const { warnZero, summary } = require('./lib/coverage-guard');

const DIR = path.join(__dirname, '..');
const CACHE = path.join(DIR, '_tmp', 'moex-codes.json');
const PDF_DIR = path.join(DIR, '_tmp', 'bullet-cloze');
const UA = 'Mozilla/5.0';
const REF = 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const EXAM = arg('--exam', 'doctor1');
const APPLY = process.argv.includes('--apply');
const { nameKey: keyName, sameName } = require('./lib/moex-normalize');

const codeCache = (() => { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; } })();
function probeCodes(code, year) {
  if (codeCache[code]) return codeCache[code];
  try {
    const out = execFileSync('python', [path.join(__dirname, 'probe-moex-codes.py'), String(+year + 1911), code],
      { encoding: 'utf8', timeout: 180000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    const list = [];
    for (const line of out.split('\n')) {
      const m = line.match(/c=(\d+)\s+s=(\w+)\s+(.+)/);
      if (m) list.push({ c: m[1], s: m[2], subject: m[3].replace(/試題|答案|更正答案/g, '').trim() });
    }
    codeCache[code] = list;
  } catch { codeCache[code] = []; }
  fs.writeFileSync(CACHE, JSON.stringify(codeCache, null, 2), 'utf8');
  return codeCache[code];
}

/** 更正備註四種寫法都要涵蓋，字元類別務必含「者」「均」 */
function parseCorrections(text) {
  const out = {};
  const i = text.indexOf('備');
  const body = i >= 0 ? text.slice(i) : text;
  for (const m of body.matchAll(/第\s*(\d{1,3})\s*題\s*(一律給分|除未作答者不給分外[^，。]*|答([ＡＢＣＤA-D、，,或者均\s]+?)[者均]?給分)/g)) {
    const n = +m[1];
    if (!m[3]) { out[n] = '送分'; continue; }
    const letters = (m[3].match(/[ＡＢＣＤA-D]/g) || [])
      .map(c => c.charCodeAt(0) > 0xFF00 ? String.fromCharCode(c.charCodeAt(0) - 0xFEE0) : c);
    if (letters.length) out[n] = [...new Set(letters)];
  }
  return out;
}

async function pdfText(buf) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  let all = '';
  for (let p = 0; p < doc.countPages(); p++) {
    const st = JSON.parse(doc.loadPage(p).toStructuredText('preserve-whitespace').asJSON());
    for (const b of st.blocks || []) for (const l of b.lines || []) all += (l.text || '').trim() + ' ';
  }
  return all;
}

async function getCorrections(code, c, s) {
  const p = path.join(PDF_DIR, `M_${code}_${c}_${s}.pdf`);
  let buf = null;
  if (fs.existsSync(p) && fs.statSync(p).size > 1000) buf = fs.readFileSync(p);
  else {
    try {
      buf = await fetchPdf(buildMoexUrl('M', code, c, s), { userAgent: UA, referer: REF });
      if (buf && buf.length > 1000) { fs.mkdirSync(PDF_DIR, { recursive: true }); fs.writeFileSync(p, buf); }
      else buf = null;
    } catch { buf = null; }
  }
  if (!buf) return null;
  try { return parseCorrections(await pdfText(buf)); } catch { return null; }
}

(async () => {
  const file = EXAM === 'doctor1' ? 'questions.json' : `questions-${EXAM}.json`;
  const json = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  const arr = (Array.isArray(json) ? json : json.questions) || [];

  const papers = new Map();
  for (const q of arr) {
    if (!q.exam_code || !q.subject) continue;
    const k = `${q.exam_code}|${q.subject}`;
    if (!papers.has(k)) papers.set(k, { code: String(q.exam_code), subject: q.subject, year: q.roc_year, items: [] });
    papers.get(k).items.push(q);
  }

  let corrected = 0, missing = 0, already = 0, noSheet = 0;
  const list = [];
  for (const p of papers.values()) {
    const cands = probeCodes(p.code, p.year).filter(x => {
      const xk = keyName(x.subject), pk = keyName(p.subject);
      return xk === pk || xk.startsWith(pk) || pk.startsWith(xk);
    });
    if (!cands.length) { noSheet++; continue; }

    let corr = null;
    for (const cand of cands) { corr = await getCorrections(p.code, cand.c, cand.s); if (corr && Object.keys(corr).length) break; }
    if (!corr || !Object.keys(corr).length) { noSheet++; continue; }

    for (const q of p.items) {
      const c = corr[q.number];
      if (!c) continue;
      corrected++;
      if (q.disputed) { already++; continue; }
      missing++;
      list.push({ id: q.id, code: p.code, subject: p.subject, n: q.number,
        rule: c === '送分' ? '一律給分' : c.join('、') + ' 均給分', ours: q.answer });
    }
  }

  console.log(`${EXAM}：有更正答案的題 ${corrected} 筆`);
  console.log(`  已標 disputed: ${already}`);
  console.log(`  ⚠️ 未標 disputed: ${missing}`);
  console.log(`  （${noSheet} 卷沒有更正卷或反查不到科目）`);
  warnZero(`${EXAM} 更正答案掃描`, corrected, '反查不到科目、或更正卷 parser 失敗（檢查表頭是「題號」還是「題序」）');
  for (const x of list.slice(0, 12)) {
    console.log(`  ${x.code} ${x.subject} #${x.n}  我們=${x.ours}  官方：${x.rule}`);
  }
  fs.writeFileSync(path.join(DIR, '_tmp', `missing-disputed-${EXAM}.json`), JSON.stringify(list, null, 2), 'utf8');

  if (APPLY && list.length) {
    const ids = new Set(list.map(x => String(x.id)));
    let n = 0;
    for (const q of arr) if (ids.has(String(q.id))) { q.disputed = true; n++; }
    fs.writeFileSync(path.join(DIR, file), JSON.stringify(json, null, 2), 'utf8');
    console.log(`\n✅ 已標記 ${n} 題為 disputed`);
  } else if (list.length) {
    console.log('\n(dry-run，加 --apply 才會標記)');
  }
})();
