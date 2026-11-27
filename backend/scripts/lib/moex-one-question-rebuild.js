/**
 * 「只重建某幾題」的共用機制：用同一張卷上**健康的那些題**認出原卷，
 * 再逐題從原卷重解題幹、選項與答案。
 *
 * 跟 rebuild-paper-from-moex.js 的方向相反：那支是找命中率**最低**的卷
 * （＝整卷裝錯了）來覆寫整卷；這支是先確認「這張就是對的卷」（命中率要夠高），
 * 然後只動指定的那幾題。整卷沒壞、只有一兩題壞掉時要用這支。
 *
 * 目前兩個使用者：
 *   · repair-moex-header-swallowed.js  —— 卷頭被當成第 1 題
 *   · repair-moex-split-stems.js       —— 題幹被切碎塞進選項格
 * 判準各自不同，但「認卷 → 重解一題 → 檢查乾不乾淨」這段完全一樣，
 * 所以放這裡共用，不要各自抄一份（抄過去的那份一定比較短，見
 * reference_moex_shared_libs）。
 *
 * id 一律不動 —— 改 id 會讓收藏與錯題夾失聯。
 */
const { probeCodes, nameCandidates, fetchSheet } = require('./moex-paper-resolve');
const { pdfQuestions } = require('./moex-pdf-parse');
const { parseAnswerSheet } = require('./moex-answer-sheet');
const { skeleton } = require('./moex-normalize');

const KEYS = ['A', 'B', 'C', 'D'];
const cmp = (t) => String(t).normalize('NFKC').replace(/\s+/g, '');

/**
 * 認出某一場某一科的原卷。
 * @returns {Promise<{c, off, hit, answers}|null>} hit 是「健康題命中率」
 */
async function identifyPaper({ exam, code, subject, siblings, broken, maxProbe = 20 }) {
  const codes = probeCodes(code, String(code).slice(0, 3));
  const { list: cands } = nameCandidates(exam, subject, codes);
  if (!cands.length) return null;

  const makeProbe = (skipBroken) => siblings
    .filter((q) => (!skipBroken || !broken.includes(q)) && String(q.question || '').length > 20)
    .map((q) => skeleton(q.question).replace(/^【題組情境】/, '').slice(0, 18))
    .filter((s) => s.length >= 14)
    .slice(0, maxProbe);
  // 「壞的那些」原本一律排除在探針之外，但呼叫方有時把**整卷**都當候選
  // （extract-missing-figures 的 targets 就是整卷 80 題），排掉之後一支探針都
  // 不剩，命中率算出來是 0，整卷被判成「對不到官方卷」靜默跳過。
  // 探針數不夠時就連壞的一起拿去打 —— 壞的那些頂多打不中，不會造成誤認。
  let probe = makeProbe(true);
  if (probe.length < 4) probe = makeProbe(false);

  let picked = null;
  for (const c of cands) {
    let off;
    try {
      const b = await fetchSheet('Q', code, c.c, c.s);
      if (!b) continue;
      off = await pdfQuestions(b);
    } catch { continue; }
    if (!off || !off.size) continue;
    const all = [...off.values()].map((x) => skeleton(x.stem)).join('|');
    const hit = probe.length ? probe.filter((s) => all.includes(s)).length / probe.length : 0;
    if (!picked || hit > picked.hit) picked = { c, off, hit };
    if (hit >= 0.9) break;
  }
  if (!picked) return null;

  let answers = {};
  try {
    const sb = await fetchSheet('S', code, picked.c.c, picked.c.s);
    if (sb) answers = await parseAnswerSheet(sb);
  } catch { /* 沒有答案卷 */ }
  return { ...picked, answers };
}

/**
 * 從已認出的原卷重解一題。
 * @param reject 額外的拒收判準 (stem, options) => string|null
 * @returns {{ok:true, stem, options, answer}|{ok:false, reason:string}}
 */
function rebuildOne(paper, q, reject) {
  const src = paper.off.get(+q.number) || paper.off.get(String(q.number));
  if (!src) return { ok: false, reason: '原卷解不到這個題號' };
  const stem = String(src.stem || '').replace(/^[\s.．、]+/, '').trim();
  if (stem.length < 8) return { ok: false, reason: '原卷這一題的題幹是空的' };
  const o = { A: src.options[0], B: src.options[1], C: src.options[2], D: src.options[3] };
  if (!KEYS.every((x) => o[x] && String(o[x]).trim())) return { ok: false, reason: '原卷這一題的選項解不齊' };
  if (KEYS.some((x) => /^[A-D]\s*[.．、]/.test(String(o[x])))) return { ok: false, reason: '原卷選項還帶著 A. 標記' };
  if (new Set(KEYS.map((x) => cmp(o[x]))).size !== 4) return { ok: false, reason: '原卷這一題的選項有重複' };
  const ans = paper.answers[String(q.number)];
  if (!ans || !/^[ABCD]$/.test(String(ans))) return { ok: false, reason: '答案卷沒給這題的單一字母答案' };
  const extra = reject ? reject(stem, o) : null;
  if (extra) return { ok: false, reason: extra };
  return { ok: true, stem, options: o, answer: String(ans) };
}

/** 就地覆寫。explanation 與 disputed 是在描述舊的、錯的那一題，要清掉。 */
function applyRebuild(q, r) {
  q.question = r.stem;
  q.options = r.options;
  q.answer = r.answer;
  q.explanation = '';
  delete q.disputed;
}

module.exports = { identifyPaper, rebuildOne, applyRebuild, KEYS, cmp };
