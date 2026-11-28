#!/usr/bin/env node
/**
 * 把被字型甩到同一行後面的下標數字搬回原位（血氧／壓力單位那一族）。
 *
 * 跟 project_subscript_shift（下標甩到**前面**）是同一個病的另一種落點：
 *   rt 115090 重症 #52「PaO 62 mm Hg、PaCO 59 mm Hg、2 2 HCO3-」
 *   rt 115090 呼吸器原理 #59 A「low level CPAP（5 cm HO）…或T- 2 2 piece」
 *   聽語 101110 基礎言語科學 #2 B「聲門下壓3-5 cm H O22」（兩個 2，一個是 A 格的）
 * 成因在原卷的文字層（數字被排到自己該在的位置之後），重解原卷一樣是壞的 ——
 * 跟 project_railway_parser_layout 的第三型同源，只能靠「這個縮寫只有一種寫法」還原。
 * 既有稽核（四格有字、不重複、不含豆腐字）一條都看不到。
 *
 * 下標的落點有兩種，不能混用同一條規則：
 *   · cmH2O —— 下標在**中間**（H 跟 O 之間），所以 O 後面的數字一律是游離的。
 *   · PaO2 / PaCO2 / HCO3 —— 下標在**字尾**，所以字尾剛好一個就是對的，
 *     兩個以上才有一個是游離的。
 *
 * 踩過的雷，不要放寬：
 *   · EtO ＝ ethylene oxide 環氧乙烷，本來就沒有下標（rt 有 10 題），
 *     所以 Et 只收 EtCO，不收 EtO；單獨的 P 只收 PCO（PO 是口服）。
 *   · SPO 大寫 ＝ Donabedian 的 Structure-Process-Outcome 模型，不是 SpO2
 *     （nursing 111030 #76），所以 Sp 只收小寫 p。
 *   · 很多題的下標本來就在，而且是真的下標字元（U+2080~U+2089），要排除。
 *
 * 對帳是這支工具的全部重點：一題之內「缺幾個下標」要跟「有幾個游離數字」
 * **數量與數值都一樣**，才動手；多一個少一個都整題不動。因為游離數字的
 * 判準寬（CJK 旁邊、連字號後面都算），光靠它自己一定會誤刪
 * （「fentanyl 3 mcg/kg」「CRT：1-2 秒」都會被當成游離數字）——
 * 對帳就是用來擋這些的，vet 那幾題實測就是這樣被擋掉的。
 *
 *   node scripts/repair-flung-subscript.js [--apply]
 */
const fs = require('fs');
const path = require('path');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');

const SUB = '\u2080-\u2089';
// 下標在中間：cmH2O / mmH2O。O 後面的數字一律是游離的。
const H2O = new RegExp('([cm]m\\s*)H\\s*O(2*)(?![0-9' + SUB + 'A-Za-z])', 'g');
// 下標在字尾：PaO2 / PaCO2 / SaO2 / SpO2 / FiO2 / PvO2 / CvO2 / PCO2 / EtCO2
const O2 = new RegExp('\\b(Pa|PA|Sa|SA|Sp|Fi|FI|Pv|Cv|Et|P)(C?O)(2*)(?![0-9' + SUB + 'A-Za-z])', 'g');
const o2ok = (a, b) => !((a === 'Et' || a === 'P') && b === 'O');
// 下標在字尾：HCO3-
const HCO3 = new RegExp('\\bHCO(3*)(?=\\s*[-\u2212])', 'g');
// 游離數字：自己單獨一個（CJK 旁邊、連字號後面都算，所以一定要靠對帳把關）
// 游離數字：自己單獨一個。範圍號裡的數字不算（3-5 cmH2O、1~3秒），
// 其餘的判準刻意放寬（CJK 旁邊、連字號後面都算），所以一定要靠對帳把關。
const STRAY = /(?<![0-9.,A-Za-z\u2080-\u2089])(?<!\d[-\u2212~\uff5e])([23])(?![-\u2212~\uff5e]?\d)(?![0-9.,%\u2080-\u2089])/g;
// 英文連字詞被游離數字切開：T- 2 2 piece / non- 2 invasive
const JOIN = /([A-Za-z])-((?:\s*[23])+)\s*([A-Za-z])/g;

/*
 * 不增不減、只是順序錯了：HCO-3 → HCO3-。
 * 這種不進入對帳（沒有數字被加掉或刪掉），所以得獲得獨立的處理；
 * 而且要先做，不然 HCO3-3 的尾數會被範圍号規則（\d- 開頭）當成「不是游離」。
 */
const neutral = (t) => String(t).replace(/\bHCO\s*([-\u2212])3(?![0-9])/g, 'HCO3$1');

/** 這一格缺幾個下標（needed）、有幾個游離數字可用（have）。 */
function tally(text) {
  const t = neutral(text);
  const needed = [], have = [];
  t.replace(H2O, (m, unit, glued) => { needed.push('2'); for (const c of glued) have.push(c); return m; });
  t.replace(O2, (m, a, b, glued) => {
    if (!o2ok(a, b)) return m;
    if (glued.length === 0) needed.push('2');
    else for (let i = 1; i < glued.length; i++) have.push('2');
    return m;
  });
  t.replace(HCO3, (m, glued) => {
    if (glued.length === 0) needed.push('3');
    else for (let i = 1; i < glued.length; i++) have.push('3');
    return m;
  });
  // 游離數字要在「填好下標之後」的文字上數，不然剛剛補進去的會被算進來
  let filled = fill(t);
  filled.replace(STRAY, (m, d) => { have.push(d); return m; });
  return { needed, have };
}

/** 只做「把下標填回原位」，不刪任何東西。 */
function fill(text) {
  let t = String(text);
  t = t.replace(H2O, (m, unit, glued) => unit + 'H2O');
  t = t.replace(O2, (m, a, b, glued) => (o2ok(a, b) ? a + b + '2' : m));
  t = t.replace(HCO3, (m, glued) => 'HCO3');
  return t;
}

const sorted = (a) => a.slice().sort().join('');

(async () => {
  const files = fs.readdirSync(BK).filter((f) => /^questions(-.*)?\.json$/.test(f) && !/\.bak/.test(f));
  let tq = 0, tc = 0, skip = 0;
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    if (!arr) continue;
    let dirty = false;
    for (const q of arr) {
      const fields = [['question', q.question]];
      for (const k of Object.keys(q.options || {})) fields.push(['opt:' + k, q.options[k]]);
      const needed = [], have = [];
      let reordered = false;
      for (const fd of fields) { if (neutral(fd[1]) !== String(fd[1])) reordered = true; }
      for (const fd of fields) { const r = tally(fd[1]); needed.push(...r.needed); have.push(...r.have); }
      if (!needed.length && !reordered) continue;
      const tag = f.replace('questions-', '').replace('\.json', '') + ' ' + q.exam_code + ' ' + q.subject + ' #' + q.number;
      /*
       * cmH2O / mmH2O 是固定寫法的壓力單位，「5-10cmH O」只有一種讀法，
       * 所以當缺的全是這一種、而且整題沒有游離數字可對帳時（數字是真的掉了），
       * 也直接填回去 —— 不刪任何東西，所以没有誤刪的風險。
       */
      const unitOnly = needed.every((d) => d === '2') && !have.length
        && fields.every((fd) => !O2.test(String(fd[1])) && !HCO3.test(String(fd[1])));
      if (!unitOnly && sorted(needed) !== sorted(have)) {
        skip++;
        console.log('  ⊘ ' + tag + '：缺 [' + sorted(needed) + ']、游離 [' + sorted(have) + '] 對不上，整題不動');
        continue;
      }
      const out = [];
      for (const fd of fields) {
        let t = fill(neutral(fd[1]));
        t = t.replace(JOIN, (m, a, ds, c) => a + '-' + c);
        /*
         * 刪掉游離數字之後的空白：兩邊都是英數字才留一個空格
         * （「氢40 2 mg/dL」→「40 mg/dL」），有一邊是中文或全形標點就整個收掉
         * （「呼吸2 2治療師」→「呼吸治療師」、「pressure 2（EPAP）」→「pressure（EPAP）」）。
         */
        t = t.replace(STRAY, '\u0000');
        t = t.replace(/\s*(?:\u0000\s*)+/g, (m, off, whole) => {
          const prev = whole[off - 1] || '';
          const next = whole[off + m.length] || '';
          const word = (c) => /[A-Za-z0-9]/.test(c);
          return word(prev) && word(next) ? ' ' : '';
        });
        if (t !== String(fd[1])) out.push([fd[0], String(fd[1]), t]);
      }
      if (!out.length) continue;
      tq++;
      for (const row of out) {
        tc++;
        console.log('  ✓ ' + tag + ' ' + row[0]);
        console.log('      舊 ' + row[1].replace(/\s+/g, ' '));
        console.log('      新 ' + row[2].replace(/\s+/g, ' '));
        if (APPLY) { if (row[0] === 'question') q.question = row[2]; else q.options[row[0].slice(4)] = row[2]; dirty = true; }
      }
    }
    if (APPLY && dirty) fs.writeFileSync(path.join(BK, f), JSON.stringify(j, null, 2) + '\n', 'utf8');
  }
  console.log('\n' + (APPLY ? '已修' : '可修') + ' ' + tq + ' 題 / ' + tc + ' 格｜對不上保留 ' + skip + ' 題');
})();
