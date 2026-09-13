#!/usr/bin/env node
/**
 * 針對「有使用者回報」的卷跑選項重建。
 *
 * 為什麼要另外一支：fix-papers-batch.js 是**掃描器驅動**的，只處理被 heuristic
 * 判定破損的卷。但有些破損掃描器認不出來——例如選項首字被吃掉
 * （`B.Bacillus anthracis` 存成 `acillus anthracis`），文字看起來完全正常。
 * 這種只有使用者看得出來。既然他們已經指出是哪一題，那一卷就值得重建一次。
 *
 * 用法：
 *   node scripts/fix-reported-papers.js            # dry-run
 *   node scripts/fix-reported-papers.js --apply
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, '..');
const CACHE = path.join(DIR, '_tmp', 'moex-codes.json');
const APPLY = process.argv.includes('--apply');
const norm = (t) => String(t).normalize('NFC').replace(/\s+/g, '');

fs.readFileSync(path.join(DIR, '.env'), 'utf-8').split('\n').forEach(l => {
  const i = l.indexOf('=');
  if (i > 0 && !l.trim().startsWith('#')) process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
});
const supabase = require(path.join(DIR, 'supabase'));

const FILES = fs.readdirSync(DIR).filter(f => /^questions(-.*)?\.json$/.test(f) && !/\.bak/.test(f));

// 題幹 -> 該題所屬的卷
const byText = new Map();
for (const f of FILES) {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  for (const q of (Array.isArray(j) ? j : j.questions) || []) {
    byText.set(norm(q.question), {
      file: f, code: String(q.exam_code), tag: q.subject_tag,
      subject: q.subject, year: q.roc_year,
    });
  }
}

const cache = (() => { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; } })();
function probeCodes(code, year) {
  if (cache[code]) return cache[code];
  try {
    const out = execFileSync('python', [path.join(__dirname, 'probe-moex-codes.py'), String(+year + 1911), code],
      { encoding: 'utf8', timeout: 180000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    const list = [];
    for (const line of out.split('\n')) {
      const m = line.match(/c=(\d+)\s+s=(\w+)\s+(.+)/);
      if (m) list.push({ c: m[1], s: m[2], subject: m[3].replace(/試題|答案|更正答案/g, '').trim() });
    }
    cache[code] = list;
  } catch { cache[code] = []; }
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2), 'utf8');
  return cache[code];
}

const keyName = (t) => String(t).replace(/[（）()【】\[\]、，,。．.\s]/g, '');

(async () => {
  const { data, error } = await supabase
    .from('reports').select('id,question_text').eq('status', 'pending').limit(2000);
  if (error) { console.error(error.message); process.exitCode = 1; return; }

  // 回報 -> 卷，去重
  const papers = new Map();
  let unmatched = 0;
  for (const r of data) {
    if (!r.question_text) { unmatched++; continue; }
    const p = byText.get(norm(r.question_text));
    if (!p) { unmatched++; continue; }
    const k = `${p.file}|${p.code}|${p.tag}`;
    if (!papers.has(k)) papers.set(k, { ...p, reports: 0 });
    papers.get(k).reports++;
  }
  console.log(`待處理回報 ${data.length} 筆 → 對應 ${papers.size} 卷（${unmatched} 筆在現況題庫找不到）\n`);

  let total = 0, noCode = 0;
  for (const p of [...papers.values()].sort((a, b) => b.reports - a.reports)) {
    const codes = probeCodes(p.code, p.year);
    const cands = codes.filter(x => {
      const xk = keyName(x.subject), pk = keyName(p.subject);
      return xk === pk || xk.startsWith(pk) || pk.startsWith(xk);
    });
    if (!cands.length) { noCode++; continue; }

    let best = null;
    for (const cand of cands) {
      const args = [path.join(__dirname, 'fix-column-fragments.js'), p.file, p.code, cand.c, cand.s, p.tag];
      let out = '';
      try { out = execFileSync('node', args, { encoding: 'utf8', timeout: 300000 }); } catch (e) { out = String(e.stdout || ''); }
      const m = out.match(/重建 (\d+) 題/);
      const n = m ? +m[1] : 0;
      if (!best || n > best.n) best = { cand, n };
      if (n > 0) break;
    }
    if (!best || !best.n) continue;

    console.log(`✔ ${p.file.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '')} ${p.code} ${p.subject}（${p.reports} 筆回報）c=${best.cand.c} s=${best.cand.s} → 重建 ${best.n} 題`);
    total += best.n;
    if (APPLY) {
      const args = [path.join(__dirname, 'fix-column-fragments.js'), p.file, p.code, best.cand.c, best.cand.s, p.tag, '--apply'];
      try { execFileSync('node', args, { encoding: 'utf8', timeout: 300000 }); } catch {}
    }
  }
  console.log(`\n總計重建 ${total} 題${noCode ? `，${noCode} 卷反查不到科目` : ''}`);
  console.log(APPLY ? '✅ 已寫入' : '(dry-run，加 --apply 才會寫入)');
})();
