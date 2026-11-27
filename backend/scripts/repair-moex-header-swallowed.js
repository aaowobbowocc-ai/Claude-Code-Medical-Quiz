#!/usr/bin/env node
/**
 * 修「卷頭被當成題目」—— 考選部試題卷第一頁的表頭（考試別／等別／類科別／科目）
 * 與作答注意事項，被解析成第 1 題的題幹與選項。
 *
 *   customs 115040 法學知識 #1
 *     題幹「15年公務人員特種考試關務人員…考試試題 考 試 別：關務人員考試」
 *     A「本科目共50題，每題2分，須用2B鉛筆…禁止使用電子計算器。」
 *     B「1憲法第154條規定，勞資糾紛之調解與仲裁…」  ← 真正的題幹擠在這一格
 *     答案 B —— 字母等於亂數
 *
 * 另一種較輕的：選項尾巴吃到換頁的卷頭
 *   police 107070 行政學 #8 D「控制幅度愈小，組織層級化數量愈多（請接背面）
 *     107年公務人員特種考試…科目：行政學」
 *
 * 做法：抓出帶「卷面家具」字樣的題，拿原卷重解那一題，整題覆寫（題幹＋選項＋答案）。
 * id 不動 —— 改 id 會讓收藏與錯題夾失聯。
 *
 * ⚠️ 判準要**帶年份**。「考試試題」三個字本身是正常題目會出現的字：
 *      railway-admin 106070 公民與英文 #19 D「依法令舉行的考試試題排除在著作權保障範圍外」
 *      state-it taipower-100 專業科目 #18 B「依法令舉行之各類考試試題及其備用試題」
 *      doctor1 107100 醫學(一) #50「當考生正專注於國家考試試題時…」
 *    這三題都是好題。所以年份＋「考試試題」要一起出現才算卷頭；
 *    而「99年國軍志願役…考選簡章」有年份卻是**簡章**不是試題，也要排除。
 *
 * 安全機制：
 *   · 選卷用命中率**最高**的候選（要 >= 0.6）—— 跟 rebuild-paper-from-moex 相反，
 *     那支是找最爛的卷來整卷重建，這支是確認「這張就是對的卷」才動一題。
 *   · 原卷那一題要解得乾淨：題幹非空且本身不是卷面家具、四個選項齊全互不相同、
 *     沒帶「A.」標記。
 *   · 官方答案卷要給出 A~D 單一字母。
 *   · 以上任一不過 -> 標 incomplete='header_swallowed' 藏起來，不硬寫。
 *
 *   node scripts/repair-moex-header-swallowed.js            # 試跑
 *   node scripts/repair-moex-header-swallowed.js --apply
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./lib/atomic-write');
const { probeCodes, nameCandidates, fetchSheet } = require('./lib/moex-paper-resolve');
const { pdfQuestions } = require('./lib/moex-pdf-parse');
const { parseAnswerSheet } = require('./lib/moex-answer-sheet');
const { skeleton } = require('./lib/moex-normalize');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const MIN_HIT = 0.6;

/** 卷面家具：只收**不可能出現在題目正文**的字樣 */
const FURNITURE = [
  /考\s*試\s*別\s*[：:]/,
  /等\s*別\s*[：:]\s*[一二三四五六]?等/,
  /類\s*科\s*別?\s*[：:]/,
  /本科目共\s*\d+\s*題/,
  /須用\s*2\s*B\s*鉛筆/,
  /依題號清楚劃記/,
  /禁止使用電子計算器/,
  /全一[張頁]/,
  /請接(背面|次頁)/,
  // 年份＋「考試試題」要一起出現（「考選簡章」「依法令舉行的考試試題」都不算）
  /\d{2,3}\s*年[^。\n]{0,60}?考\s*試\s*試\s*題/,
];
const isFurniture = (t) => FURNITURE.some((re) => re.test(String(t || '')));
const cmp = (t) => String(t).normalize('NFKC').replace(/\s+/g, '');
const KEYS = ['A', 'B', 'C', 'D'];

/** 家具在這個字串裡最早出現的位置（沒有就回 -1） */
function furnitureAt(t) {
  let at = -1;
  for (const re of FURNITURE) {
    const m = re.exec(String(t || ''));
    if (m && (at < 0 || m.index < at)) at = m.index;
  }
  return at;
}

/**
 * 只有一格選項的尾巴帶家具時，把尾巴切掉。回 null 表示不符合條件。
 * 條件刻意嚴：題幹乾淨、只有一格中彈、切完還有 4 個字以上、且不會跟別格一樣。
 */
function trimOne(q) {
  if (furnitureAt(q.question) >= 0) return null;
  const o = q.options || {};
  const keys = Object.keys(o);
  const hit = keys.filter((k) => furnitureAt(o[k]) >= 0);
  if (hit.length !== 1) return null;
  const key = hit[0];
  const before = String(o[key]);
  const at = furnitureAt(before);
  if (at <= 0) return null;
  const after = before.slice(0, at).replace(/[\s（(]+$/, '').trim();
  if (after.length < 4) return null;
  if (keys.some((k) => k !== key && cmp(o[k]) === cmp(after))) return null;
  return { key, before, after };
}

(async () => {
  const fixed = [], trimmed = [], hidden = [], skipped = {};
  const skip = (r) => { skipped[r] = (skipped[r] || 0) + 1; };

  for (const f of fs.readdirSync(BK).filter((x) => /^questions(-.*)?\.json$/.test(x) && !/\.bak/.test(x))) {
    const fp = path.join(BK, f);
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    if (!Array.isArray(arr)) continue;
    const exam = f === 'questions.json' ? 'doctor1' : f.replace(/^questions-|\.json$/g, '');

    const bad = arr.filter((q) => !q.incomplete
      && (isFurniture(q.question) || Object.values(q.options || {}).some(isFurniture)));
    if (!bad.length) continue;

    // 按「場次＋科目」分組，一組只抓一次原卷
    const groups = new Map();
    for (const q of bad) {
      const k = `${q.exam_code}|${q.subject}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(q);
    }

    let dirty = false;
    for (const [k, qs] of groups) {
      const [code, subject] = k.split('|');
      const siblings = arr.filter((q) => String(q.exam_code) === code && q.subject === subject);
      const codes = probeCodes(code, String(code).slice(0, 3));
      const { list: cands } = nameCandidates(exam, subject, codes);
      // 找不到原卷時不要「略過」—— 會被抓出來就是因為記錄裡有卷面家具，
      // 那已經証明這筆是壞的；修不起來就藏起來，比讓卷頭碎片當選項顯示好。
      if (!cands.length) { for (const q of qs) { hidden.push({ exam, q, reason: '反查不到這一科的卷' }); if (APPLY) { q.incomplete = 'header_swallowed'; dirty = true; } } continue; }

      // 用**健康的那些題**去認卷：命中率最高的才是對的卷
      const probe = siblings.filter((q) => !qs.includes(q) && String(q.question || '').length > 20)
        .map((q) => skeleton(q.question).replace(/^【題組情境】/, '').slice(0, 18))
        .filter((s) => s.length >= 14).slice(0, 20);
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
      if (!picked) { for (const q of qs) { hidden.push({ exam, q, reason: '原卷解不出題目（選項標記掉光了）' }); if (APPLY) { q.incomplete = 'header_swallowed'; dirty = true; } } continue; }
      if (picked.hit < MIN_HIT) {
        for (const q of qs) {
          hidden.push({ exam, q, reason: `認不出是哪張卷（最高命中率 ${(picked.hit * 100).toFixed(0)}%）` });
          if (APPLY) { q.incomplete = 'header_swallowed'; dirty = true; }
        }
        continue;
      }

      let answers = {};
      try {
        const sb = await fetchSheet('S', code, picked.c.c, picked.c.s);
        if (sb) answers = await parseAnswerSheet(sb);
      } catch { /* 沒有答案卷 */ }

      for (const q of qs) {
        const src = picked.off.get(+q.number) || picked.off.get(String(q.number));
        const ans = answers[String(q.number)];
        let o = null;
        const reason = (() => {
          if (!src) return '原卷解不到這個題號';
          const stem = String(src.stem || '').replace(/^[\s.．、]+/, '').trim();
          if (stem.length < 8) return '原卷這一題的題幹是空的';
          if (isFurniture(stem)) return '原卷解出來的題幹還是卷面家具';
          o = { A: src.options[0], B: src.options[1], C: src.options[2], D: src.options[3] };
          if (!KEYS.every((x) => o[x] && String(o[x]).trim())) return '原卷這一題的選項解不齊';
          if (KEYS.some((x) => /^[A-D]\s*[.．、]/.test(String(o[x])))) return '原卷選項還帶著 A. 標記';
          if (KEYS.some((x) => isFurniture(o[x]))) return '原卷選項裡還有卷面家具';
          if (new Set(KEYS.map((x) => cmp(o[x]))).size !== 4) return '原卷這一題的選項有重複';
          if (!ans || !/^[ABCD]$/.test(String(ans))) return '答案卷沒給這題的單一字母答案';
          return null;
        })();

        if (reason) {
          // 原卷救不回來之前，先試「只是某一格的尾巴吃到換頁的卷頭」這種輕症：
          //   police 107070 行政學 #8 D「控制幅度愈小，組織層級化數量愈多（請接背面）107年…科目：行政學」
          // 這種原卷重解也沒用（PDF 文字層就是把頁首併在那一格），但切掉尾巴就對了。
          // 只在**題幹與其他三格都乾淨、只有一格帶家具**時才切 —— 多格中彈代表
          // 整題錯位（題幹把選項吃進去、選項格裝的是頁首碎片），那不是切得回來的。
          const t = trimOne(q);
          if (t) {
            trimmed.push({ exam, q, key: t.key, before: t.before, after: t.after });
            if (APPLY) { q.options[t.key] = t.after; dirty = true; }
            continue;
          }
          hidden.push({ exam, q, reason });
          if (APPLY) { q.incomplete = 'header_swallowed'; dirty = true; }
          continue;
        }
        const stem = String(src.stem).replace(/^[\s.．、]+/, '').trim();
        fixed.push({ exam, q, stem, o, oldAns: q.answer, newAns: String(ans), hit: picked.hit });
        if (APPLY) {
          q.question = stem;
          q.options = o;
          q.answer = String(ans);
          q.explanation = '';
          delete q.disputed;
          dirty = true;
        }
      }
    }
    if (APPLY && dirty) atomicWriteJson(fp, j);
  }

  for (const r of fixed) {
    console.log(`${r.exam} ${r.q.exam_code} ${r.q.subject} #${r.q.number}  （認卷命中率 ${(r.hit * 100).toFixed(0)}%）`);
    console.log(`   題幹 -> ${r.stem.replace(/\s+/g, ' ').slice(0, 90)}`);
    for (const x of KEYS) console.log(`   ${x}) ${String(r.o[x]).replace(/\s+/g, ' ').slice(0, 70)}`);
    console.log(`   答案 ${r.oldAns} -> ${r.newAns}${r.oldAns === r.newAns ? '（一樣）' : '  ⚠️ 答案也改了'}`);
  }
  if (trimmed.length) {
    console.log('\n── 只是某一格的尾巴吃到換頁的卷頭，切掉 ──');
    for (const r of trimmed) {
      console.log(`${r.exam} ${r.q.exam_code} ${r.q.subject} #${r.q.number} (${r.key})`);
      console.log(`   舊 ${JSON.stringify(r.before.replace(/\s+/g, ' ').slice(0, 100))}`);
      console.log(`   新 ${JSON.stringify(r.after.replace(/\s+/g, ' ').slice(0, 100))}`);
    }
  }
  if (hidden.length) {
    console.log('\n── 原卷也救不回來，標起來藏掉 ──');
    for (const r of hidden) console.log(`${r.exam} ${r.q.exam_code} ${r.q.subject} #${r.q.number}  ${r.reason}`);
  }
  console.log(`\n${APPLY ? '已修' : '可修'} ${fixed.length} 題｜${APPLY ? '已切尾巴' : '可切尾巴'} ${trimmed.length} 題｜${APPLY ? '已標' : '可標'} ${hidden.length} 題`);
  if (Object.keys(skipped).length) console.log('跳過:', JSON.stringify(skipped, null, 1));
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})();
