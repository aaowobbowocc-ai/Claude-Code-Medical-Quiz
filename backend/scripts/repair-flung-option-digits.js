#!/usr/bin/env node
/**
 * 把被甩到字尾的選項數字搬回字首。
 *
 *   nutrition 108020 公共衛生營養學 #16
 *     A「小時內6」  B「12小時內」  C「24小時內」  D「48小時內」
 *   真正的 A 是「6小時內」。
 *
 * 成因在**原卷的文字層**，不是解析器：那個數字的 x 座標排在自己選項標記的
 * 左邊，依閱讀順序收行就被甩到這一格的尾巴（跟 project_ceec_subscript_order、
 * project_railway_parser_layout ③ 同源）。用 lib/moex-one-question-rebuild
 * 重解原卷出來一樣是「小時內6」，所以不能靠重解修。
 *
 * 判準很窄，就是要窄：
 *   · 這一格**數字在字尾**、而同題至少兩格**數字在字首**
 *   · 把尾巴的數字搬到最前面之後，去掉開頭數字的剩餘部分要跟某個
 *     姊妹格一字不差（「小時內6」→「6小時內」，姊妹格是「12小時內」）
 * 兩條都過才動。全站符合的只有 2 題 —— 寬一點的判準（「字尾有數字」）
 * 會抓到 30 題，裡面「Co-60」「cyclooxygenase 2」那種全是正常選項。
 *
 *   node scripts/repair-flung-option-digits.js            # 試跑
 *   node scripts/repair-flung-option-digits.js --apply
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./lib/atomic-write');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const nz = (t) => String(t == null ? '' : t).trim();
const lead = (t) => /^\d/.test(t);
const trail = (t) => /\d$/.test(t);
/** 去掉開頭那串數字，留下「形狀」（「12小時內」與「6小時內」的形狀都是「小時內」） */
const shape = (t) => t.replace(/^\d+(?:[.,]\d+)?/, '');

const files = [
  ...fs.readdirSync(BK).filter((n) => /^questions(-[a-z0-9-]*)?\.json$/.test(n)).map((n) => path.join(BK, n)),
  ...fs.readdirSync(path.join(BK, 'shared-banks')).filter((n) => /^common_.*\.json$/.test(n))
    .map((n) => path.join(BK, 'shared-banks', n)),
];

const plan = [];
for (const p of files) {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const arr = Array.isArray(raw) ? raw : raw.questions;
  if (!Array.isArray(arr)) continue;
  let dirty = false;
  for (const q of arr) {
    const o = q.options || {};
    const ks = Object.keys(o).filter((k) => /^[A-E]$/.test(k));
    if (ks.length < 4) continue;
    const vals = Object.fromEntries(ks.map((k) => [k, nz(o[k])]));
    if (ks.some((k) => !vals[k])) continue;
    const bad = ks.filter((k) => trail(vals[k]) && !lead(vals[k]));
    const good = ks.filter((k) => lead(vals[k]) && !trail(vals[k]));
    if (!bad.length || good.length < 2) continue;
    const moves = {};
    for (const k of bad) {
      const m = /^(.*?)(\d+(?:[.,]\d+)?)$/.exec(vals[k]);
      if (!m || !m[1]) { moves.fail = true; break; }
      const moved = m[2] + m[1];
      if (!good.some((g) => shape(vals[g]) === shape(moved))) { moves.fail = true; break; }
      moves[k] = moved;
    }
    if (moves.fail) continue;
    for (const k of bad) {
      plan.push({ file: path.basename(p), code: q.exam_code, subject: q.subject, number: q.number,
        k, answer: q.answer, before: vals[k], after: moves[k] });
      if (APPLY) { q.options[k] = moves[k]; dirty = true; }
    }
  }
  if (APPLY && dirty) atomicWriteJson(p, raw);
}

console.log(`${APPLY ? '已搬回' : '可搬回'} ${plan.length} 個被甩到字尾的選項數字`);
for (const r of plan) {
  console.log(`  ✓ ${r.file.replace(/^questions-?|\.json$/g, '')} ${r.code} ${r.subject} #${r.number} (${r.k}${r.k === r.answer ? '＝正解' : ''})`);
  console.log(`      ${JSON.stringify(r.before)} -> ${JSON.stringify(r.after)}`);
}
if (!APPLY) console.log('\n(試跑；加 --apply 才寫入)');
