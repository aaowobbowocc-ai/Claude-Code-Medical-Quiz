#!/usr/bin/env node
/**
 * 修「組合題選項的圈號 ①②③④ 全塌成 ①」。
 *
 * 2026-11-09 發現：考選部 PDF 的題幹與選項常用**兩套字型**
 * （題幹 PMingLiU、選項 MingLiU）。選項那套的 ToUnicode 壞掉，
 * ②③④⑤ 全被解成 U+2460（①），偶爾解成別的數字。
 * 於是「①②③」「②③④」存進題庫都變成「①①①」。
 * 全站 43 卷 65 題，而且**健康報告完全看不到**
 * （只有剛好塌成完全相同的那幾題會被「選項重複」抓到）。
 *
 * ⚠️ 兩個判準都單獨不可信，必須合用：
 *   1. 字形比對：把字形切出來跟題幹的 ①②③④（解得對）比。
 *      跨字型的噪音（10~12）跟數字彼此的差距（②③ 只差 10.4）同量級，
 *      實測會把 ⑤ 判成 ③、把 ② 判成 ③。
 *   2. 遞增約束：組合題選項內的數字一定由小到大。
 *      但它只給偏序 —— 實測「①②③④ / ②③④⑤」兩個選項，
 *      光靠遞增無法決定首尾那兩個字形是 ① 還是 ②。
 * 作法：用遞增約束**篩**出所有合法指派，再用字形距離**選**總分最低的那組，
 * 且要求最佳解唯一（與次佳有明顯差距）才寫入。
 *
 * 驗證過的真值：counseling-psychology 103100 團體諮商與心理治療，
 * 字形圖人工判讀 = ①②③④⑤①④②⑤③，與本演算法輸出完全一致。
 *
 *   node scripts/decode-circled-options.js --exam tcm2 --code 106030 --subject "中醫臨床醫學(三)"
 *   node scripts/decode-circled-options.js --all [--apply]
 *   加 --montage 會輸出 _tmp/glyphs-<exam>-<code>.png 供人工抽檢
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');

const BK = path.join(__dirname, '..');
const arg = k => {
  const eq = process.argv.find(a => a.startsWith('--' + k + '='));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = process.argv.indexOf('--' + k);
  return i > 0 && !String(process.argv[i + 1] || '').startsWith('--') ? process.argv[i + 1] : null;
};
const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');
const MONTAGE = process.argv.includes('--montage');
// --pin g12=8,g5=6：人工看字形圖後把字形釘進跨卷字形庫。
// 只在三個條件都成立時才寫：該字形目前是「沒釘死」的、要釘的數字在可行解集合內、
// 而且會先把它單獨放大重繪一次（_tmp/pin-*.png）讓人覆核。釘完不套用，要再跑一次。
const PIN = (arg('pin') || '').split(',').filter(Boolean).reduce((m, kv) => {
  const mm = /^g(\d+)=(\d+)$/.exec(kv.trim());
  if (!mm) { console.error('--pin 格式應為 g12=8'); process.exit(1); }
  m[+mm[1]] = +mm[2]; return m;
}, {});

const FILE = e => (e === 'doctor1' ? 'questions.json' : 'questions-' + e + '.json');
const CIRCLED = /[①-⑳]/;            // ①..⑳
const MARKER = /[-]/;             // ⒶⒷⒸⒹ 的 PUA 標記
// 定位題幹時要忽略的字元：空白、PUA 選項標記、C1 控制字元，
// 以及 C1 被 cp1252 解碼過一次變成的那幾個罕用標點（‚ƒ„…†‡ˆ‰Š‹ŒŽ）與對不到字碼的 U+FFFD。
// nursing 105030 #50 的題庫與原卷就是同一個標記的兩種編碼，不忽略就對不上。
const MARKERS = /[\u0080-\u009F\u00AD\u200B-\u200D\uFEFF\uE000-\uF8FF\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\uFFFD]/g;        // 選項標記：PUA、C1，以及 C1 被 cp1252 解過一次的那幾個罕用標點
const NOISE = /[\s\u0080-\u009F\u00AD\u200B-\u200D\uFEFF\uE000-\uF8FF\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\uFFFD]/;    // 定位題幹時一併忽略空白
const flat = s => String(s).replace(new RegExp(NOISE.source, 'g'), '');
const Z = 8, S = 112, Q = 32;
const LIB = path.join(__dirname, "data", "circled-glyph-lib.json");

/** 把一個字的墨水範圍裁出來、置中貼到 S×S，不縮放（同字級才可比） */
function glyphBitmap(px, W, H, quad) {
  const x0 = Math.max(0, Math.floor(quad[0] * Z) - 3), x1 = Math.min(W, Math.ceil(quad[6] * Z) + 3);
  const y0 = Math.max(0, Math.floor(quad[1] * Z) - 3), y1 = Math.min(H, Math.ceil(quad[5] * Z) + 3);
  let ix0 = x1, ix1 = x0, iy0 = y1, iy1 = y0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++)
    if (px[y * W + x] < 200) { if (x < ix0) ix0 = x; if (x > ix1) ix1 = x; if (y < iy0) iy0 = y; if (y > iy1) iy1 = y; }
  if (ix1 <= ix0 || iy1 <= iy0) return null;
  const w = ix1 - ix0 + 1, h = iy1 - iy0 + 1;
  if (w > S || h > S) return null;
  const g = new Uint8Array(S * S).fill(255);
  const ox = (S - w) >> 1, oy = (S - h) >> 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[(oy + y) * S + ox + x] = px[(iy0 + y) * W + ix0 + x];
  // 跨卷用的簽章：把墨水框縮放到 Q×Q 二值化。不同卷的字級可能不同，
  // 所以跨卷比對一定要縮放過；同卷內的分群則用上面不縮放的 g（較精確）。
  const sig = new Uint8Array(Q * Q);
  for (let j = 0; j < Q; j++) for (let i = 0; i < Q; i++) {
    const sx0 = ix0 + Math.floor(i * w / Q), sx1 = Math.max(sx0 + 1, ix0 + Math.floor((i + 1) * w / Q));
    const sy0 = iy0 + Math.floor(j * h / Q), sy1 = Math.max(sy0 + 1, iy0 + Math.floor((j + 1) * h / Q));
    let s = 0, c = 0;
    for (let y = sy0; y < sy1; y++) for (let x = sx0; x < sx1; x++) { s += px[y * W + x]; c++; }
    sig[j * Q + i] = (s / c) < 170 ? 1 : 0;
  }
  return { g: g, sig: sig };
}
/** 跨卷字形簽章的距離：容許 ±1 格位移的不同位元比例（%） */
function sigDist(a, b) {
  let best = Infinity;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    let d = 0, c = 0;
    for (let y = 1; y < Q - 1; y++) for (let x = 1; x < Q - 1; x++) { if (a[y * Q + x] !== b[(y + dy) * Q + x + dx]) d++; c++; }
    const m = (d / c) * 100; if (m < best) best = m;
  }
  return best;
}
const sigEncode = s => Buffer.from(s).toString('base64');
const sigDecode = s => new Uint8Array(Buffer.from(s, 'base64'));
/** 容許 ±2px 位移的平均絕對差 */
function dist(a, b) {
  let best = Infinity;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    let s = 0, c = 0;
    for (let y = 3; y < S - 3; y++) for (let x = 3; x < S - 3; x++) { s += Math.abs(a.g[y * S + x] - b.g[(y + dy) * S + x + dx]); c++; }
    const m = s / c; if (m < best) best = m;
  }
  return best;
}

/** 讀一份卷：回傳依閱讀順序的字元陣列，圈號字附上字形群號 */
async function readPaper(buf) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  const chars = [], clusters = [];
  for (let pi = 0; pi < doc.countPages(); pi++) {
    const page = doc.loadPage(pi);
    const st = page.toStructuredText('preserve-whitespace');
    const hits = [];
    st.walk({ onChar(c, o, font, size, quad) { hits.push({ c, quad, size }); } });
    if (!hits.some(h => CIRCLED.test(h.c))) { for (const h of hits) chars.push({ c: h.c }); continue; }
    const pm = page.toPixmap(mupdf.Matrix.scale(Z, Z), mupdf.ColorSpace.DeviceGray);
    const px = pm.getPixels(), W = pm.getWidth(), H = pm.getHeight();
    for (const h of hits) {
      if (!CIRCLED.test(h.c)) { chars.push({ c: h.c }); continue; }
      const b = glyphBitmap(px, W, H, h.quad);
      if (!b) { chars.push({ c: h.c }); continue; }
      let hit = clusters.find(cl => dist(cl.rep, b) <= 4);
      if (!hit) { hit = { rep: b, id: clusters.length, n: 0 }; clusters.push(hit); }
      hit.n++;
      chars.push({ c: h.c, g: hit.id });
    }
  }
  return { chars, clusters };
}

/**
 * 跨卷字形庫。一張卷通常只有 1~3 題組合題，約束不夠把所有字形釘死；
 * 但字形是跨卷共用的，所以把釘死過的存起來，下一張卷就少一個未知數。
 * （實測：只靠單卷 65 題裡只修得動 12 題，接上字形庫後大幅提升。）
 */
const lib = {
  items: [],
  load() {
    try { this.items = JSON.parse(fs.readFileSync(LIB, 'utf8')).map(r => ({ digit: r.digit, src: r.src, sig: sigDecode(r.sig) })); }
    catch (e) { this.items = []; }
    return this;
  },
  /** 回傳已知數字，或 null。閾值 4% 以內視為同一個字形 */
  lookup(sig) {
    if (!sig) return null;
    let best = null, bd = Infinity;
    for (const it of this.items) { const d = sigDist(sig, it.sig); if (d < bd) { bd = d; best = it; } }
    return bd <= 4 ? best.digit : null;
  },
  add(sig, digit, src) {
    if (!sig) return false;
    for (const it of this.items) {
      if (sigDist(sig, it.sig) > 4) continue;
      // 同一個字形被判成兩個不同數字 —— 一定有一邊錯了，寧可都不信
      if (it.digit !== digit) { it.conflict = true; }
      return false;
    }
    this.items.push({ digit: digit, src: src, sig: sig });
    return true;
  },
  save() {
    const keep = this.items.filter(it => !it.conflict);
    const dropped = this.items.length - keep.length;
    fs.mkdirSync(path.dirname(LIB), { recursive: true });
    fs.writeFileSync(LIB, JSON.stringify(keep.map(it => ({ digit: it.digit, src: it.src, sig: sigEncode(it.sig) })), null, 1), 'utf8');
    return dropped;
  },
};

/**
 * 每個數字的參考字形。
 * 一個字形群若在整份卷裡**只被解成同一個字元**，那個解碼多半是對的
 * （壞掉的那套字型會把好幾個不同字形都解成 ①，所以反過來說，
 *  同一群只對應一種解碼、而且別的群沒搶同一個字元，就可信）。
 */
function buildRefs(chars, clusters) {
  const decodes = {};
  for (const ch of chars) if (ch.g !== undefined) (decodes[ch.g] = decodes[ch.g] || new Set()).add(ch.c);
  const claim = {};
  for (const cl of clusters) {
    const d = decodes[cl.id];
    if (!d || d.size !== 1) continue;
    const n = [...d][0].codePointAt(0) - 0x245F;       // ①=1
    (claim[n] = claim[n] || []).push(cl);
  }
  const refs = {};
  for (const n of Object.keys(claim)) {
    // 同一個字元被多個字形群搶：那是壞字型造成的，不可信
    if (claim[n].length === 1) refs[n] = claim[n][0];
  }
  return refs;
}

/**
 * 解**整卷**：一個字形只能對應一個數字。
 *
 * ⚠️ 一題一題各自解會出錯。實測 counseling-psychology 104030：
 *    同一個字形群 g6 在 #4 被判成 ②（對）、在 #22 被判成 ①（錯），
 *    因為單題的約束不足以釘死它。把整卷的選項一起解，
 *    #4 釘住的 g6=② 就會把 #22 的錯解排除掉。
 *
 * cases: [{ seqs:[[群號…]×4], K }]  回傳 { ok, map:{群號→數字}, margin }
 */
function decodePaper(cases, clusters, refs, forced) {
  forced = forced || {};
  const used = [...new Set(cases.flatMap(c => c.seqs.flat()))];
  if (!used.length) return { why: '沒有圈號' };
  /*
   * 題幹序位把用到的字形全部釘死時，答案已經唯一確定，不必搜尋 ——
   * 也**不能**套遞增約束：「下列處置順序何者正確」這種題型的選項是排列，
   * 本來就不遞增（tcm2 106030 #46 暈針處置八步驟）。
   * 唯一還要過的是「同一題四個選項必須互不相同」，不過就放棄整卷。
   */
  if (used.every(g => forced[g] !== undefined)) {
    for (const c of cases) {
      const keys = c.seqs.map(s => s.map(g => forced[g]).join(','));
      if (new Set(keys).size !== keys.length) return { why: '題幹序位解出的四個選項有重複' };
    }
    const conf = {};
    for (const g of used) conf[g] = true;
    return { ok: true, map: forced, confident: conf, shaky: [], feasible: {} };
  }
  const maxK = Math.max.apply(null, cases.map(c => c.K));
  if (used.length > 16 || maxK > 12) return { why: '字形群或項目數過多' };
  // 每個字形群的上限 = 它出現過的題目裡最小的 K
  const cap = {};
  for (const g of used) cap[g] = maxK;
  for (const c of cases) for (const g of new Set(c.seqs.flat())) cap[g] = Math.min(cap[g], c.K);

  /*
   * 成本表。兩個來源，字形庫優先：
   *   - 跨卷字形庫：之前在別張卷釘死過同一個字形 → 指派成那個數字成本 0，其餘 40。
   *     字形是跨卷共用的，所以 A 卷釘死的字形到 B 卷就是已知條件。
   *     但它不是硬性約束 —— 仍要通過遞增與互異檢查，萬一庫裡是錯的會解不出來而不是靜默寫錯。
   *   - 同卷題幹的參考字形：拿不到庫的時候用，但跨字型噪音大（見檔頭）。
   */
  const cost = {};
  for (const g of used) {
    cost[g] = {};
    const known = lib.lookup(clusters[g].rep.sig);
    for (let d = 1; d <= maxK; d++) {
      cost[g][d] = known ? (d === known ? 0 : 40)
        : (refs[d] ? dist(clusters[g].rep, refs[d].rep) : 15);
    }
  }
  /*
   * 相鄰約束：序列裡前一個一定小於後一個。
   * ⚠️ 只對「組合題」成立。「下列處置順序何者正確」這種**排列題**的選項
   *    是 1..K 的重排，本來就不遞增（tcm2 106030 #46 暈針處置八步驟）。
   *    特徵很好認：四個選項的圈號個數都剛好等於 K。
   *    這種題改用「同一個選項裡的數字互不重複」當約束。
   */
  const pairs = [], distinctIn = [];
  for (const c of cases) {
    const perm = c.K >= 4 && c.seqs.every(s => s.length === c.K);
    for (const s of c.seqs) {
      if (perm) distinctIn.push(s);
      else for (let i = 1; i < s.length; i++) pairs.push([s[i - 1], s[i]]);
    }
  }

  // minScore[g][d] = 「把字形 g 指派成數字 d」時，整卷能達到的最低總分。
  // 用它判斷每個字形**各自**有多確定，比看整卷總分的次佳差距細緻得多：
  // 兩個解可能只差一個字形，整卷邊際很小，但其餘字形其實都釘死了。
  const minScore = {};
  const feasible = {};
  for (const g of used) { minScore[g] = {}; feasible[g] = new Set(); for (let d = 1; d <= maxK; d++) minScore[g][d] = Infinity; }
  const asg = {};
  let best = null, nodes = 0;
  (function dfs(i) {
    if (nodes++ > 3e6) return;
    if (i === used.length) {
      for (const c of cases) {
        const keys = c.seqs.map(s => s.map(g => asg[g]).join(','));
        if (new Set(keys).size !== keys.length) return;        // 同一題的四個選項必須互不相同
      }
      const score = used.reduce((t, g) => t + cost[g][asg[g]], 0);
      for (const g of used) { if (score < minScore[g][asg[g]]) minScore[g][asg[g]] = score; feasible[g].add(asg[g]); }
      if (!best || score < best.score) best = { map: Object.assign({}, asg), score };
      return;
    }
    const g = used[i];
    for (let d = 1; d <= cap[g]; d++) {
      if (forced[g] !== undefined && forced[g] !== d) continue;   // 題幹序位釘死的字形
      asg[g] = d;
      // 兩端都指派好的相鄰約束，馬上檢查
      let bad = false;
      for (const pr of pairs) {
        if (pr[0] !== g && pr[1] !== g) continue;
        if (asg[pr[0]] === undefined || asg[pr[1]] === undefined) continue;
        if (!(asg[pr[0]] < asg[pr[1]])) { bad = true; break; }
      }
      if (!bad) for (const seq of distinctIn) {
        if (!seq.includes(g)) continue;
        const vs = seq.map(x => asg[x]).filter(v => v !== undefined);
        if (new Set(vs).size !== vs.length) { bad = true; break; }
      }
      if (!bad) dfs(i + 1);
    }
    delete asg[g];
  })(0);
  if (nodes > 3e6) return { why: '搜尋空間過大' };
  if (!best) return { why: '遞增約束下無解' };
  /*
   * 一個字形算「釘死」只有兩種情況：
   *   1. 所有合法解都指派同一個數字 —— 純粹由遞增＋互異約束決定，與字形距離無關。
   *   2. 跨卷字形庫完全命中 —— 之前在別張卷用 (1) 釘死過同一個字形。
   *
   * ⚠️ **不可以**用字形距離當判準。跨字型噪音跟數字彼此的差距同量級；
   *    而且題幹參考字形常常建不起來（壞字型把好幾個字形都解成同一個字元，
   *    buildRefs 就會全部放棄），成本表退化成中性值後，距離會做出任意的決定。
   *    實測 clinical-psychology 106030 #17 就是這樣把 ②③ 解成 ①③，
   *    還把那個 ② 當成 ① 餵進字形庫污染後面的卷。
   *    距離只留著當同分時的排序，不參與「敢不敢寫」的判斷。
   */
  const confident = {}, shaky = [];
  for (const g of used) {
    confident[g] = feasible[g].size === 1 || lib.lookup(clusters[g].rep.sig) === best.map[g];
    if (!confident[g]) shaky.push('g' + g + '(' + [...feasible[g]].sort().join('/') + '?)');
  }
  return { ok: true, map: best.map, confident: confident, shaky: shaky, feasible: feasible };
}

/*
 * 排序題的分隔符「＞」「→」在原卷常被排成一個獨立的直欄，
 * 文字層就變成「>>>>①④②⑤③」這種讀不了的樣子
 * （clinical-psychology 106030 #34 思覺失調症家族風險排序）。
 * 分隔符數量剛好是數字數量減一時把它們交錯回去 —— 字元組成不變，只動順序。
 */
function weave(t) {
  const m = /^([>＞→]{2,})([①-⑳]{3,})$/.exec(t) || /^([①-⑳]{3,})([>＞→]{2,})$/.exec(t);
  if (!m) return t;
  const sep = /[>＞→]/.test(m[1]) ? m[1] : m[2];
  const dig = sep === m[1] ? m[2] : m[1];
  if (dig.length !== sep.length + 1) return t;
  return [...dig].map((d, i) => (i ? sep[i - 1] + d : d)).join('');
}

async function doPaper(exam, code, subject, targets, stats) {
  const p0 = path.join(BK, FILE(exam));
  const rawText = fs.readFileSync(p0, "utf8");
  const j = JSON.parse(rawText);
  const arr = Array.isArray(j) ? j : j.questions;
  const items = arr.filter(q => q && String(q.exam_code) === code && q.subject === subject).sort((a, b) => a.number - b.number);
  const p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items });
  if (!p) { console.log('  ✗ 對不到官方卷'); stats.nopaper++; return false; }
  const buf = await fetchSheet('Q', code, p.c, p.s);
  if (!buf) { console.log('  ✗ 抓不到 PDF'); stats.nopaper++; return false; }
  const r0 = await readPaper(buf);
  const chars = r0.chars, clusters = r0.clusters;
  const refs = buildRefs(chars, clusters);
  // ⚠️ 定位題幹時要連 PUA 選項標記一起忽略：nursing 105030 #50 的題幹項目
  //    「①<PUA>入睡時間…」在 ① 後面夾了一個標記，害題庫題幹在原卷裡找不到。
  const keep = c => !NOISE.test(c);
  const ftext = chars.map(c => c.c).filter(keep).join('');
  const map = []; chars.forEach((c, i) => { if (keep(c.c)) map.push(i); });

  /*
   * --probe：不改題庫，只把原卷「每一組四個選項標記」前面的題幹與解好的選項列出來。
   * 用在槽位被覆蓋、題庫裡題幹是空的、沒辦法用題幹定位的時候
   * （counseling-psychology 103100 的三題就是這樣）。
   * 圈號一律查跨卷字形庫，查不到就原樣印出來，由人判讀。
   */
  if (process.argv.includes('--probe')) {
    const mkAll = [];
    chars.forEach((c, i) => { if (MARKER.test(c.c)) mkAll.push(i); });
    for (let k = 0; k + 3 < mkAll.length; k += 4) {
      const stemFrom = k === 0 ? 0 : mkAll[k - 1];
      const stem = chars.slice(Math.max(stemFrom, mkAll[k] - 420), mkAll[k]).map(c => c.c).join('').replace(/\s+/g, ' ').trim();
      const opts = [];
      for (let o = 0; o < 4; o++) {
        const a = mkAll[k + o] + 1, b = o === 3 ? Math.min(chars.length, mkAll[k + 4] !== undefined ? mkAll[k + 4] : chars.length) : mkAll[k + o + 1];
        opts.push(chars.slice(a, b).map(c => {
          if (c.g === undefined) return c.c;
          const d = lib.lookup(clusters[c.g].rep.sig);
          return d ? String.fromCodePoint(0x245F + d) : c.c + '?';
        }).join('').replace(/\s+/g, ' ').trim().slice(0, 90));
      }
      console.log('\n--- 題幹: ' + stem.slice(-200));
      ['A', 'B', 'C', 'D'].forEach((L, i) => console.log('    ' + L + '. ' + opts[i]));
    }
    return false;
  }

  // 第一趟：把每一題的選項區段與項目數定位出來
  const cases = [];
  /*
   * 題幹的項目清單必然是 ①②③…N 依序排列。若清單長度剛好等於 K，
   * 就可以反過來把清單裡第 i 個字形釘死成數字 i —— 這比字形距離可靠得多。
   * ⚠️ 驗證只能拿 buildRefs 挑出來的「可信字形」比對，不能拿解碼字元比。
   *    壞字型會把好幾個不同字形都解成 ①，直接比會把正確的假設否決掉：
   *    tcm2 106030 #46 的題幹前五項全塌成 ①，但 ⑥⑦⑧ 解對了，
   *    它們落在第 6/7/8 個位置，正好印證「清單＝依序」。
   * 兩題對同一個字形釘出不同數字 → 整個放棄那個字形。
   */
  const forced = {}, forcedBad = new Set();
  for (const q of items) {
    if (!targets.includes(q.number)) continue;
    /*
     * 題組題的題幹被 inline-followup-context.js 在前面接上了整組的情境與前面各題
     * （【題組情境】…承上題…承上題…），原卷裡當然找不到。真正的題目是最後一段。
     */
    const qtext = /【題組情境】/.test(q.question) ? String(q.question).split(/\n\s*\n/).pop() : q.question;
    const probe = flat(qtext).slice(0, 20);
    if (probe.length < 10) { console.log('  ⚠ #' + q.number + ' 題幹太短，略過'); stats.skip++; continue; }
    const fi = ftext.indexOf(probe);
    if (fi < 0) {
      console.log('  ⚠ #' + q.number + ' 原卷找不到題幹');
      if (process.env.DBG) { console.log('    probe=' + JSON.stringify(probe)); const z = ftext.indexOf(probe.slice(0, 8)); console.log('    前8字位置=' + z + '  原卷=' + JSON.stringify(ftext.slice(z, z + 40))); }
      stats.skip++; continue;
    }
    if (ftext.indexOf(probe, fi + 1) >= 0) { console.log('  ⚠ #' + q.number + ' 題幹在原卷出現多次'); stats.skip++; continue; }
    const start = map[fi];
    const mk = [];
    for (let i = start; i < chars.length && mk.length < 5; i++) if (MARKER.test(chars[i].c)) mk.push(i);
    if (mk.length < 4) { console.log('  ⚠ #' + q.number + ' 找不到四個選項標記'); stats.skip++; continue; }
    const stem = chars.slice(start, mk[0]).map(c => c.c).join('');
    const stemDigits = [...stem].filter(c => CIRCLED.test(c)).map(c => c.codePointAt(0) - 0x245F);
    const K = stemDigits.length ? Math.max.apply(null, stemDigits) : 0;
    if (!K) { console.log('  ⚠ #' + q.number + ' 題幹沒有 ①②③ 項目'); stats.skip++; continue; }

    const runs = [], seqs = [];
    for (let k = 0; k < 4; k++) {
      const a = mk[k] + 1;
      const b = k === 3 ? (mk[4] !== undefined ? mk[4] : chars.length) : mk[k + 1];
      let run = chars.slice(a, b);
      // 選項跨頁時會把下一頁的頁首（「代號：」「頁次：」）吃進來。任何選項都可能遇到。
      // （字元索引要用陣列位置算，不能用 join 後的字串索引 —— 一個字元可能佔兩個 UTF-16 單位）
      for (let i = 1; i < run.length; i++) {
        if (!/[代頁座等類科考]/.test(run[i].c)) continue;
        const t = run.slice(i, i + 8).map(c => c.c).join('');
        if (/^(代號|頁次|座號|等別|類科名稱|科目名稱|考試時間|考試名稱)\s*[：:]/.test(t)) { run = run.slice(0, i); break; }
      }
      if (k === 3) {
        // 最精確的判準：下一題的題號一定是本題 + 1。
        // ⚠️ 原本只靠「數字後面接漢字」，碰到下一題以英文開頭就失效
        //    （speech-therapist 105090 #15 的選項 D 吃進了「16 Lee Silverman Voice Treatment…」，
        //     害整題被當成選項文字對不上而略過）。
        const nxt = String(q.number + 1);
        for (let i = 1; i < run.length; i++) {
          if (!/\d/.test(run[i].c) || !/\s/.test(run[i - 1].c)) continue;
          let jx = i; while (jx + 1 < run.length && /\d/.test(run[jx + 1].c)) jx++;
          if (run.slice(i, jx + 1).map(c => c.c).join('') !== nxt) continue;
          // 題號前面必須已經出現過圈號，否則可能只是選項裡的數字
          if (!run.slice(0, i).some(c => c.g !== undefined)) continue;
          run = run.slice(0, i); break;
        }
      }
      if (k === 3) {
        // 最後一個選項要在「下一題題號」處打住。
        // ⚠️ 題號與題幹之間、題號與前一個選項之間都可能有空白，
        //    所以找下一個非空白字時要跳過空白，否則整段下一題會被當成選項 D。
        for (let i = 1; i < run.length; i++) {
          if (!/\d/.test(run[i].c)) continue;
          let jx = i; while (jx + 1 < run.length && /[\d\s]/.test(run[jx + 1].c)) jx++;
          const after = run.slice(jx).find(c => !/[\d\s]/.test(c.c));
          // ⚠️ 下一題的題幹不一定以漢字開頭：social-worker 105090 #11 開頭是「，
          //    漏掉全形標點就會把整段下一題當成選項 D。
          if (after && /[一-鿿①-⑳「『（《〈【〔]/.test(after.c)) { run = run.slice(0, i); break; }
        }
      }
      runs.push(run);
      seqs.push(run.filter(c => c.g !== undefined).map(c => c.g));
    }
    /*
     * 排序題的選項在原卷文字層常整體位移一格：每個選項的第一個圈號
     * 被排在前一個選項的尾巴（speech-therapist 107110 #16 的治療順序題）。
     * 簽章很乾淨 —— 四段的圈號個數是 K+1, K, K, K-1，總數剛好 4K。
     * 往後推一格就補正了；非圈號的字（→）數量不變，所以安全檢查照樣擋得住。
     */
    const lens = seqs.map(s => s.length);
    if (K >= 3 && lens[0] === K + 1 && lens[1] === K && lens[2] === K && lens[3] === K - 1) {
      for (let k = 0; k < 3; k++) {
        let z = runs[k].length - 1;
        while (z >= 0 && runs[k][z].g === undefined) z--;
        if (z < 0) break;
        runs[k + 1] = runs[k].splice(z).concat(runs[k + 1]);
      }
      seqs.length = 0;
      for (const r of runs) seqs.push(r.filter(c => c.g !== undefined).map(c => c.g));
      console.log('  （#' + q.number + ' 選項整體位移一格，已往後推回）');
    }
    if (seqs.some(s => !s.length)) { console.log('  ⚠ #' + q.number + ' 有選項不含圈號'); stats.skip++; continue; }
    const sc = chars.slice(start, mk[0]).filter(c => c.g !== undefined);
    const sg = sc.map(c => c.g);
    if (sg.length === K && K >= 3) {
      // 用題幹自己的解碼字元驗證順序假設：
      //   verified = 解出來剛好等於序位的個數（壞字型解不出這種巧合）
      //   contra   = 解出來比序位**大**的個數。塌掉只會塌成較小的數字
      //              （整批壓成 ①），所以出現比序位大的就不是單純塌掉，假設作廢。
      let verified = 0, contra = 0, deep = false;
      sc.forEach((c, i) => {
        const d = c.c.codePointAt(0) - 0x245F;
        if (d === i + 1) { verified++; if (i >= 2) deep = true; }
        else if (d > i + 1) contra++;
      });
      if (verified >= 2 && deep && !contra) sg.forEach((g, i) => {
        if (forced[g] !== undefined && forced[g] !== i + 1) forcedBad.add(g);
        forced[g] = i + 1;
      });
    }
    cases.push({ q: q, runs: runs, seqs: seqs, K: K, stemRun: chars.slice(start, mk[0]) });
  }

  let changed = 0;
  if (!cases.length) { if (MONTAGE && clusters.length) await writeMontage(exam, code, subject, clusters); return false; }
  for (const g of forcedBad) delete forced[g];
  if (Object.keys(forced).length) console.log('  （題幹序位釘死 ' + Object.keys(forced).length + ' 個字形）');
  const r = decodePaper(cases, clusters, refs, forced);
  if (!r.ok) {
    console.log('  ✗ 整卷解不出來：' + r.why);
    stats.skip += cases.length;
    if (MONTAGE && clusters.length) await writeMontage(exam, code, subject, clusters);
    return false;
  }

  if (r.shaky.length) console.log('  （沒釘死的字形：' + r.shaky.join(' ') + '，用到它們的題會略過）');
  if (Object.keys(PIN).length) {
    const ok = [];
    for (const gs of Object.keys(PIN)) {
      const g = +gs, d = PIN[g];
      if (!clusters[g]) { console.log('  ✗ 這張卷沒有 g' + g); continue; }
      if (r.confident[g]) { console.log('  ✗ g' + g + ' 本來就釘死了（=' + r.map[g] + '），不用人工釘'); continue; }
      if (!r.feasible[g] || !r.feasible[g].has(d)) {
        console.log('  ✗ g' + g + '=' + d + ' 不在可行解 (' + [...(r.feasible[g] || [])].sort().join('/') + ') 內，判讀有誤');
        continue;
      }
      ok.push([g, d]);
    }
    if (ok.length) {
      await writePinMontage(exam, code, subject, clusters, ok);
      // 字形庫被污染過兩次，而且污染是靜默的（下一張卷才錯）。所以釘入分兩步：
      // --pin 只出覆核圖，看過沒問題再加 --pin-confirm 才寫進庫。
      if (!process.argv.includes('--pin-confirm')) {
        console.log('  （只出覆核圖，沒有寫入。看過確認無誤後加 --pin-confirm）');
        return false;
      }
      let n = 0;
      for (const [g, d] of ok) if (lib.add(clusters[g].rep.sig, d, 'pin:' + exam + ' ' + code)) n++;
      const dr = lib.save();
      console.log('  （人工釘入 ' + n + ' 個字形' + (dr ? '，剔除衝突 ' + dr : '') + '；覆核圖已輸出，再跑一次才會套用）');
    }
    return false;
  }
  // 只從**真的被採用**的題學字形。
  // ⚠️ 早期版本是「凡是釘死的字形都學」，結果 clinical-psychology 106030
  //    整題被略過（兩個字形沒釘死），卻還是把 4 個字形寫進庫，其中一個 ② 被標成 ①，
  //    再透過字形庫污染後面的卷。學習的門檻必須跟寫入一樣嚴。
  const learnFrom = new Set();

  // 第二趟：用整卷共用的字形→數字對照重建選項
  for (const cs of cases) {
    const q = cs.q, runs = cs.runs, seqs = cs.seqs, K = cs.K;
    const un = [...new Set(seqs.flat())].filter(g => !r.confident[g]);
    if (un.length) { console.log('  ⚠ #' + q.number + ' 用到沒釘死的字形 ' + un.map(g => 'g' + g).join(',')); stats.skip++; continue; }
    const rebuilt = runs.map(run => weave(run.map(c => (c.g !== undefined ? String.fromCodePoint(0x245F + r.map[c.g]) : c.c)).join('').replace(/\s+/g, ' ').trim()));
    // 安全檢查：非圈號的字必須跟題庫現存的一致（確認抓到的是同一題的選項）
    const strip = s => String(s).replace(/[①-⑳\s]/g, '');
    const keys = ['A', 'B', 'C', 'D'];
    const mismatch = keys.findIndex((k, i) => strip((q.options || {})[k]) !== strip(rebuilt[i]));
    /*
     * 「題幹的項目清單掉進選項 A」—— 另一種壞法，跟圈號塌掉疊在一起。
     *   speech-therapist 105090 #41：題幹只剩「…包含那些階段？」，
     *   選項 A 是「①口腔準備期 ②口腔期 ③咽部期 ④食道期」，真正的 A 是「①②③④」。
     * 只在四個前提都成立時連題幹一起重建，否則寧可略過：
     *   1. 只有 A 對不上（BCD 的非圈號文字都對得上）
     *   2. 題庫的 A 文字確實出現在**原卷的題幹區段**裡（證明它是題幹不是選項）
     *   3. 原卷題幹以題庫題幹開頭（只補尾巴，不換題）
     *   4. 原卷題幹的圈號是 ①②③…K 嚴格遞增不重複（證明題幹那套字型沒壞）
     */
    let newStem = null;
    if (mismatch >= 0) {
      // 原卷題幹會夾著選項標記（PUA／C1／被 cp1252 解過的標點），
      // 那些字元不能跟著寫進題庫，但要保留空白結構。
      const ps = cs.stemRun.map(c => c.c).join('')
        .replace(MARKERS, '')
        .replace(/\s+/g, ' ').trim();
      const ds = [...ps].filter(c => CIRCLED.test(c)).map(c => c.codePointAt(0) - 0x245F);
      // 原卷題幹的圈號必須是 ①②③…K 嚴格遞增不重複 —— 證明題幹那套字型沒壞，重建才有意義
      const wellFormed = ds.length === K && ds.every((d, i) => d === i + 1);
      // bare = 去圈號＋去空白＋去標記字元。兩邊都要這樣比，
      // 否則原卷題幹裡夾著的 ⑤⑥⑦ 或 mojibake 標記會讓比對永遠失敗。
      const bare = s => flat(String(s).replace(/[①-⑳]/g, ''));
      if (wellFormed) {
        // (a) 選項 A 只是題幹尾巴的複本（題幹沒缺，只有 A 被污染）
        if (mismatch === 0 && keys.slice(1).every((k, i) => strip((q.options || {})[k]) === strip(rebuilt[i + 1]))
            && bare(ps).includes(bare(q.options.A)) && flat(ps).startsWith(flat(q.question))) newStem = ps;
        // (b) 題幹被切斷，前 m 個選項其實是題幹的後半段。
        //     nursing 105030 #50：題幹只到「…有1/3」，A/B/C 是它的續段，
        //     真正的四個選項全擠在 D 裡。要求「題幹＋前 m 個選項」剛好等於原卷題幹，
        //     而且剩下的選項只剩圈號（沒有會被蓋掉的內容），才敢整題重建。
        for (let m = 1; m <= 3 && !newStem; m++) {
          const joined = String(q.question) + keys.slice(0, m).map(k => (q.options || {})[k]).join('');
          if (bare(joined) !== bare(ps)) continue;
          if (!keys.slice(m).every(k => !bare((q.options || {})[k]))) continue;
          newStem = ps;
        }
      }
    }
    if (mismatch >= 0 && !newStem) {
      console.log('  ⚠ #' + q.number + ' 選項 ' + keys[mismatch] + ' 的非圈號文字對不上，略過');
      console.log('      題庫:' + JSON.stringify(String((q.options || {})[keys[mismatch]]).slice(0, 40)) + '  原卷:' + JSON.stringify(rebuilt[mismatch].slice(0, 40)));
      stats.skip++; continue;
    }
    const before = keys.map(k => (q.options || {})[k]).join(' / ');
    const after = rebuilt.join(' / ');
    if (newStem && flat(newStem) !== flat(q.question)) console.log('  #' + q.number + ' 題幹補回項目清單：…' + newStem.slice(Math.max(0, flat(q.question).length - 10)).slice(0, 60));
    seqs.flat().forEach(g => learnFrom.add(g));
    if (before === after && !newStem) { stats.nochange++; continue; }
    if (MONTAGE) console.log("      群序: " + seqs.map(function(s,i){return "ABCD"[i]+"="+s.map(function(g){return "g"+g+"→"+r.map[g]}).join(" ")}).join("  "));
    console.log("  #" + q.number + '  ' + before + '   →   ' + after + '   (K=' + K + ')');
    if (APPLY) { keys.forEach((k, i) => { q.options[k] = rebuilt[i]; }); if (newStem) q.question = newStem; }
    changed++; stats.fixed++;
  }
  let learned = 0;
  for (const g of learnFrom) if (lib.add(clusters[g].rep.sig, r.map[g], exam + ' ' + code)) learned++;
  const dropped = learnFrom.size ? lib.save() : 0;
  if (learned) console.log('  （字形庫 +' + learned + (dropped ? '，剔除衝突 ' + dropped : '') + '）');
  if (MONTAGE && clusters.length) await writeMontage(exam, code, subject, clusters);
  // 保留原本的檔尾換行，否則每個題庫檔都會多一筆「\ No newline at end of file」的雜訊 diff
  if (APPLY && changed) fs.writeFileSync(p0, JSON.stringify(j, null, 2) + (rawText.endsWith('\n') ? '\n' : ''), 'utf8');
  return changed > 0;
}

// 釘字形前的覆核圖：只畫要釘的那幾個，原始解析度不縮，避免在幾十格的全卷圖上把 ⑥ 看成 ⑧。
async function writePinMontage(exam, code, subject, clusters, pins) {
  const mupdf = await import('mupdf');
  const PAD = 10, CW = S + PAD * 2, W2 = CW * pins.length, H2 = S + PAD * 2;
  const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W2, H2], false);
  const dst = pm.getPixels(); dst.fill(255);
  pins.forEach(([g], i) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) dst[(y + PAD) * W2 + i * CW + PAD + x] = clusters[g].rep.g[y * S + x];
    for (let y = 0; y < H2; y++) dst[y * W2 + i * CW] = 0;
  });
  fs.mkdirSync(path.join(BK, '_tmp'), { recursive: true });
  const f = path.join(BK, '_tmp', 'pin-' + exam + '-' + code + '-' + subject.replace(/[^\w一-鿿]/g, '') + '.png');
  fs.writeFileSync(f, pm.asPNG());
  console.log('  [覆核圖] ' + f + '  左到右：' + pins.map(([g, d]) => 'g' + g + '→' + d).join('  '));
}

async function writeMontage(exam, code, subject, clusters) {
  const mupdf = await import('mupdf');
  const PAD = 8, CW = S + PAD * 2, W2 = CW * clusters.length, H2 = S + PAD * 2;
  const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W2, H2], false);
  const dst = pm.getPixels(); dst.fill(255);
  clusters.forEach((c, i) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) dst[(y + PAD) * W2 + i * CW + PAD + x] = c.rep.g[y * S + x];
    for (let y = 0; y < H2; y++) dst[y * W2 + i * CW] = 0;
  });
  fs.mkdirSync(path.join(BK, '_tmp'), { recursive: true });
  const f = path.join(BK, '_tmp', 'glyphs-' + exam + '-' + code + '-' + subject.replace(/[^\w一-鿿]/g, '') + '.png');
  fs.writeFileSync(f, pm.asPNG());
  console.log('  [字形圖] ' + f + '  共 ' + clusters.length + ' 群（左到右 g0..g' + (clusters.length - 1) + '）');
}

(async () => {
  const jobs = {};
  for (const f of fs.readdirSync(BK).filter(n => /^questions(-.*)?\.json$/.test(n) && !/\.bak/.test(n))) {
    const exam = f === 'questions.json' ? 'doctor1' : f.replace(/^questions-/, '').replace(/\.json$/, '');
    let raw; try { raw = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')); } catch (e) { continue; }
    const arr = Array.isArray(raw) ? raw : raw.questions; if (!Array.isArray(arr)) continue;
    for (const q of arr) {
      const o = q && q.options; if (!o) continue;
      if (!['A', 'B', 'C', 'D', 'E'].some(k => (String(o[k] || '').match(/①/g) || []).length >= 2)) continue;
      const key = exam + '|' + q.exam_code + '|' + q.subject;
      (jobs[key] = jobs[key] || []).push(q.number);
    }
  }
  let keys = Object.keys(jobs).sort();
  // ⚠️ mupdf 在同一個 process 連跑多卷會 handle leak（實測第 40 卷左右 malloc 失敗），
  //    所以批次要用 --list 列出工作，外面一卷開一個 node。
  if (process.argv.includes('--list')) { keys.forEach(k => console.log(k)); return; }
  if (!ALL) {
    const e = arg('exam'), c = arg('code'), s = arg('subject');
    if (!e || !c || !s) { console.error('需要 --exam --code --subject，或 --all'); process.exit(1); }
    keys = [e + '|' + c + '|' + s];
    if (!jobs[keys[0]]) jobs[keys[0]] = (arg('nums') || '').split(',').filter(Boolean).map(Number);
  }
  lib.load();
  // 字形庫自檢圖：每一列是「被判成同一個數字」的所有字形。
  // 一列裡出現不同數字就是庫髒了 —— 套用前一定要看這張。
  if (process.argv.includes('--lib-montage')) {
    const mupdf = await import('mupdf');
    const digits = [...new Set(lib.items.map(i => i.digit))].sort((a, b) => a - b);
    const cols = Math.max.apply(null, digits.map(d => lib.items.filter(i => i.digit === d).length));
    const C = Q * 2 + 6, W2 = C * cols, H2 = C * digits.length;
    const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W2, H2], false);
    const dst = pm.getPixels(); dst.fill(255);
    digits.forEach((d, row) => {
      lib.items.filter(i => i.digit === d).forEach((it, col) => {
        for (let y = 0; y < Q * 2; y++) for (let x = 0; x < Q * 2; x++)
          dst[(row * C + 3 + y) * W2 + col * C + 3 + x] = it.sig[(y >> 1) * Q + (x >> 1)] ? 0 : 255;
      });
      for (let x = 0; x < W2; x++) dst[(row * C) * W2 + x] = 0;
    });
    fs.mkdirSync(path.join(BK, '_tmp'), { recursive: true });
    fs.writeFileSync(path.join(BK, '_tmp', 'glyph-lib.png'), pm.asPNG());
    console.log('字形庫 ' + lib.items.length + ' 個字形，' + digits.length + ' 列（由上到下 = ' + digits.map(d => String.fromCodePoint(0x245F + d)).join(' ') + '）');
    console.log('已寫 ' + path.join(BK, '_tmp', 'glyph-lib.png'));
    return;
  }
  const stats = { fixed: 0, skip: 0, nopaper: 0, nochange: 0 };
  for (const key of keys) {
    const parts = key.split('|');
    const exam = parts[0], code = parts[1], subject = parts.slice(2).join('|');
    console.log('\n■ ' + exam + ' ' + code + ' ' + subject + '  (' + jobs[key].length + ' 題)');
    try { await doPaper(exam, code, subject, jobs[key], stats); }
    catch (e) { console.log('  ✗ ' + e.message); stats.nopaper++; }
  }
  console.log('\n修好 ' + stats.fixed + '｜無變化 ' + stats.nochange + '｜略過 ' + stats.skip + '｜拿不到卷 ' + stats.nopaper);
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})().catch(e => { console.error(e.stack); process.exit(1); });
