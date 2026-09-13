#!/usr/bin/env node
/**
 * 批次跑 fix-column-fragments.js：自動反查每卷的類科碼/科目碼，逐卷重建選項。
 *
 * 為什麼需要：破損題散在 900 多卷，而每卷的 c/s 都要先向考選部反查
 * （舊年度的碼跟現行完全不同，見 scripts/probe-moex-codes.py）。
 * 這支把「掃破損 → 反查 c/s → 比對科目名 → 跑重建」串起來，並把反查結果
 * 快取到 _tmp/moex-codes.json，同一場次不會重複打考選部。
 *
 * 用法：
 *   node scripts/fix-papers-batch.js --exam nutrition            # dry-run 單一考試
 *   node scripts/fix-papers-batch.js --exam nutrition --apply
 *   node scripts/fix-papers-batch.js --top 20 --apply            # 破損最多的前 20 卷
 *
 * 只處理考選部題源；gsat（大考中心）會自動跳過。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, '..');
const CACHE = path.join(DIR, '_tmp', 'moex-codes.json');
const SKIP_EXAMS = new Set(['gsat']);   // 非考選部題源

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const onlyExam = arg('--exam');
const top = arg('--top') ? +arg('--top') : null;

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; }
}
function saveCache(c) {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(c, null, 2), 'utf8');
}

/** 向考選部反查某場次的 (c, s, 科目名) 清單，結果快取 */
function probeCodes(examCode, rocYear, cache) {
  if (cache[examCode]) return cache[examCode];
  const ad = String(+rocYear + 1911);
  let out = '';
  try {
    out = execFileSync('python', [path.join(__dirname, 'probe-moex-codes.py'), ad, examCode],
      { encoding: 'utf8', timeout: 180000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  } catch (e) {
    console.log(`   ⚠️ 反查 ${examCode} 失敗: ${String(e.message).slice(0, 80)}`);
    cache[examCode] = [];
    saveCache(cache);
    return [];
  }
  const list = [];
  for (const line of out.split('\n')) {
    const m = line.match(/c=(\d+)\s+s=(\w+)\s+(.+)/);
    if (m) list.push({ c: m[1], s: m[2], subject: m[3].replace(/試題|答案|更正答案/g, '').trim() });
  }
  cache[examCode] = list;
  saveCache(cache);
  return list;
}

/** 跑重建腳本，回傳 {rebuilt, skipped, output} */
function runFixer(file, code, c, s, tag, apply) {
  const a = [path.join(__dirname, 'fix-column-fragments.js'), file, code, c, s, tag];
  if (apply) a.push('--apply');
  try {
    const out = execFileSync('node', a, { encoding: 'utf8', timeout: 300000 });
    const m = out.match(/重建 (\d+) 題，跳過 (\d+) 題/);
    return { rebuilt: m ? +m[1] : 0, skipped: m ? +m[2] : 0, output: out };
  } catch (e) {
    return { rebuilt: 0, skipped: 0, output: String(e.stdout || e.message) };
  }
}

// ── 掃出破損卷 ────────────────────────────────────────────────
const scan = execFileSync('node', [path.join(__dirname, 'scan-broken-options.js'), '--limit', '3000'],
  { encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024 });

const papers = [];
for (const line of scan.split('\n')) {
  const m = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\d+)(第\S+?)\s{2,}(\S.*?)\s{2,}(\S+.*)$/);
  if (!m) continue;
  const [, n, exam, code, year, session, subject, why] = m;
  if (SKIP_EXAMS.has(exam)) continue;
  if (/no-stem/.test(why)) continue;          // 題幹遺失，這支修不了
  // 英文卷多半是克漏字/閱讀測驗：題號內嵌在文章裡，區塊切分不可靠 → 整卷跳過
  if (/英文|English/.test(subject)) continue;
  if (onlyExam && exam !== onlyExam) continue;
  papers.push({ n: +n, exam, code, year, session, subject: subject.trim(), why });
}

const targets = top ? papers.slice(0, top) : papers;
console.log(`目標 ${targets.length} 卷（${targets.reduce((s, p) => s + p.n, 0)} 題疑似破損）\n`);

const cache = loadCache();
let totalFixed = 0, noCode = 0, noMatch = 0;

for (const p of targets) {
  // 醫師一階的檔名是 questions.json（沒有 -doctor1 後綴），掃描器輸出會顯示成 doctor1
  const file = p.exam === 'doctor1' ? 'questions.json' : `questions-${p.exam}.json`;
  const j = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  const arr = Array.isArray(j) ? j : j.questions;
  // 同一卷可能有兩個 subject_tag（聽力/語言治療的 p/s 雙 id 互補），
  // 只取第一個會讓另一半的題永遠沒被處理。
  const tags = [...new Set(arr
    .filter(q => String(q.exam_code) === p.code && q.subject === p.subject)
    .map(q => q.subject_tag))];
  if (!tags.length) { noMatch++; continue; }
  const sample = { subject_tag: tags[0] };

  const codes = probeCodes(p.code, p.year, cache);
  if (!codes.length) { noCode++; continue; }

  // 科目名對得起來的候選（同名可能跨多個類科，逐一試，靠題幹比對自然淘汰）。
  // 比對前要正規化：我們的科目名與考選部常差在全形/半形括號、空白、頓號，
  // 例如「臨床心理學特論(一)」vs「臨床心理學特論（一）（包括…）」直接比會對不上。
  const key = (t) => String(t).replace(/[（）()【】\[\]、，,。．.\s]/g, '');
  const pk = key(p.subject);
  const cands = codes.filter(x => {
    const xk = key(x.subject);
    return xk === pk || xk.startsWith(pk) || pk.startsWith(xk);
  });
  // 名稱完全對不上時（例如 dental2 存成「卷一~卷四」、考選部叫「牙醫學(三)~(六)」），
  // 不要硬猜對照表——直接把該場次所有科目都當候選試一遍。
  // fix-column-fragments 會用題幹前綴比對，對不上的卷會整卷跳過，不會改錯。
  let tryList = cands;
  if (!tryList.length) {
    if (!args.includes('--brute')) {
      console.log(`⨯ ${p.exam} ${p.code} ${p.subject}：科目名對不上（加 --brute 可全試，但很慢）`);
      noMatch++; continue;
    }
    tryList = codes.slice(0, 40);
    console.log(`? ${p.exam} ${p.code} ${p.subject}：科目名對不上，改試全部 ${tryList.length} 個候選`);
  }

  let best = null;
  for (const cand of tryList) {
    let n = 0;
    for (const tag of tags) n += runFixer(file, p.code, cand.c, cand.s, tag, false).rebuilt;
    if (!best || n > best.n) best = { cand, n };
    if (n > 0) break;   // 對到就好，不用試完
  }
  if (!best || best.n === 0) {
    console.log(`· ${p.exam} ${p.code} ${p.subject}：無可重建（疑似誤判 ${p.n} 題）`);
    continue;
  }

  console.log(`✔ ${p.exam} ${p.code} ${p.subject}  c=${best.cand.c} s=${best.cand.s}  重建 ${best.n} 題${tags.length > 1 ? `（${tags.length} 個 tag）` : ''}`);
  if (APPLY) for (const tag of tags) runFixer(file, p.code, best.cand.c, best.cand.s, tag, true);
  totalFixed += best.n;
}

console.log(`\n總計重建 ${totalFixed} 題`);
if (noCode) console.log(`反查失敗 ${noCode} 卷`);
if (noMatch) console.log(`科目對不上 ${noMatch} 卷`);
console.log(APPLY ? '✅ 已寫入' : '(dry-run，加 --apply 才會寫入)');
