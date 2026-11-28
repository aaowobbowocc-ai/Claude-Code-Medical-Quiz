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
const { parseColumnAware } = require('./moex-column-parser');
const { parseAnswerSheet } = require('./moex-answer-sheet');
const { skeleton } = require('./moex-normalize');

const KEYS = ['A', 'B', 'C', 'D'];
const cmp = (t) => String(t).normalize('NFKC').replace(/\s+/g, '');

/**
 * parseColumnAware 回「題號 -> {question, options:{A,B,C,D}}」的物件，
 * pdfQuestions 回「題號 -> {stem, options:[4]}」的 Map。下游（rebuildOne）
 * 只認後者，所以在這裡轉成同一個形狀，不要讓兩種形狀流出去。
 */
function columnMap(obj) {
  const m = new Map();
  for (const [num, q] of Object.entries(obj || {})) {
    const o = q && q.options;
    if (!o) continue;
    const arr = KEYS.map((k) => String(o[k] == null ? '' : o[k]).trim());
    if (!arr.every(Boolean)) continue;
    const stem = String(q.question == null ? '' : q.question).trim();
    if (!stem) continue;
    m.set(+num, { stem, options: arr });
  }
  return m;
}

/**
 * 第三條退路：鐵路卷那支 pdfjs 版面解析器。
 *
 * 為什麼還要第三支：公職的「國文（作文、公文與測驗）」測驗段長這樣 ——
 * 題號**內嵌在第一行行首**（「4 《大學》：「所惡於上…」），選項靠縮排
 * 分兩欄（x≈74／x≈327）而且**完全沒有標記可以認**。
 * 題號不自成一行，parseColumnAware 的錨點掃不到；而真正的選項標記是
 * PUA 字元，mupdf 根本不吐出來（兩個選項於是黏成同一段文字）。
 * pdfjs 會保留那些標記（U+E18C~E190 ＝ ⒜⒝⒞⒟），所以只有這條路讀得出來。
 *
 * 不把那幾支函式搬過來是刻意的：抄一份一定會跟 scrape-railway 漂移
 * （見 reference_moex_shared_libs）。延遲 require 以免影響其他使用者的啟動。
 */
async function railwayMap(buf, maxOpts) {
  const S = require('../scrape-railway.js');
  const list = S.parseQuestions(S.buildLogicalLines(await S.extractPositionedText(buf)), maxOpts || 4);
  const m = new Map();
  for (const q of list || []) {
    const o = q && q.options;
    if (!o) continue;
    const arr = KEYS.map((k) => String(o[k] == null ? '' : o[k]).trim());
    if (!arr.every(Boolean)) continue;
    const stem = String(q.question == null ? '' : q.question).trim();
    if (!stem) continue;
    m.set(+q.number, { stem, options: arr });
  }
  return m;
}

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
    .map((q) => ({ num: +q.number, s: skeleton(q.question).replace(/^【題組情境】/, '').slice(0, 18) }))
    .filter((p) => p.s.length >= 14)
    .slice(0, maxProbe);
  // 「壞的那些」原本一律排除在探針之外，但呼叫方有時把**整卷**都當候選
  // （extract-missing-figures 的 targets 就是整卷 80 題），排掉之後一支探針都
  // 不剩，命中率算出來是 0，整卷被判成「對不到官方卷」靜默跳過。
  // 探針數不夠時就連壞的一起拿去打 —— 壞的那些頂多打不中，不會造成誤認。
  let probe = makeProbe(true);
  if (probe.length < 4) probe = makeProbe(false);

  /**
   * 這一份解析結果打中幾成的探針。認卷與「解得對不對」其實是同一個訊號。
   *
   * 分母只算「解析器真的有解出那個題號」的探針。混合卷的克漏字題組
   * （customs 108050 英文 #6-14：題號下面直接就是選項、沒有題幹）
   * 解析器本來就讀不出來，拿那 9 支探針當分母會把命中率的天花板壓到
   * 53%，門檻 60% 一比，**對的卷反而被判成認不出來**。
   *
   * 代價是分母會變小，所以加一道絕對下限：打中的支數不夠就一律算 0 ——
   * 只解出一兩題而剛好都對，不足以證明抓到的是對的卷。
   */
  const rate = (off) => {
    if (!off || !off.size || !probe.length) return 0;
    const all = [...off.values()].map((x) => skeleton(x.stem)).join('|');
    const reachable = probe.filter((p) => off.has(p.num));
    const pool = reachable.length >= 4 ? reachable : probe;
    const matched = pool.filter((p) => all.includes(p.s)).length;
    if (matched < Math.min(4, pool.length)) return 0;
    return matched / pool.length;
  };

  let picked = null;
  for (const c of cands) {
    let off = null;
    let hit = 0;
    try {
      const b = await fetchSheet('Q', code, c.c, c.s);
      if (!b) continue;
      off = await pdfQuestions(b);
      hit = rate(off);
      // 公職的「甲、申論題 ＋ 乙、測驗題」混合卷，測驗段長這樣：
      //     x40  「19」
      //     x60  「According to the passage, why do passports come in dark shades?」
      //     x60「To show patriotism…」x185「To coordinate…」x313「To look formal…」x439「To fit in…」
      // 題號單獨一行、四個選項排在**同一列**而且完全沒有 A./B./C./D. 標記，
      // 只能靠 x 座標分欄。pdfQuestions 兩條路（標記、幾何「最後四行＝選項」）
      // 都讀不出來 —— customs 108050 英文整卷回 0 題，於是三支 repair 腳本
      // 一律報「認不出是哪張卷（最高命中率 0%）」而放棄，題目其實印在卷上。
      // 命中率不夠高才多解一次（分欄解析器慢得多），兩份取命中率高的那個。
      if (hit < 0.9) {
        for (const parse of [async () => columnMap(await parseColumnAware(b)), () => railwayMap(b)]) {
          let alt = null;
          try { alt = await parse(); } catch { continue; }
          const altHit = rate(alt);
          if (altHit > hit) { off = alt; hit = altHit; }
          if (hit >= 0.9) break;
        }
      }
    } catch { continue; }
    if (!off || !off.size) continue;
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
