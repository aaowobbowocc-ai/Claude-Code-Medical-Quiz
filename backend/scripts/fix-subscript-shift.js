#!/usr/bin/env node
/**
 * 修復 PDF 抽字造成的「下標數字錯位」。
 *
 * 兩種樣態（皆源自考選部 PDF 把下標字元另外排版，抽文字時位置跑掉）：
 *   類型1  緊鄰：  "SaO 2"            → "SaO2"
 *   類型2  被推到字串尾巴： "由5～7 cm HO開始2"  → "由5～7 cmH2O開始"
 *
 * 只處理白名單內的醫學氣體/血液氣體符號，且類型2 必須「字串尾端是孤立數字」才動，
 * 避免把正常的數字結尾（如「小於55」）誤判。
 *
 * 用法：
 *   node scripts/fix-subscript-shift.js            # dry-run，只印出會改什麼
 *   node scripts/fix-subscript-shift.js --apply    # 實際寫回 questions-*.json
 *   node scripts/fix-subscript-shift.js --file rt  # 只處理單一考試
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..');

// token → 補上下標後的正確寫法。key 是「缺了下標」的樣子。
// 注意 H2O 的下標在中間，其餘都在字尾，所以用對照表而不是「token+數字」。
const TOKENS = [
  ['PetCO', 'PetCO2'], ['PETCO', 'PETCO2'], ['EtCO', 'EtCO2'], ['ETCO', 'ETCO2'],
  ['PaCO', 'PaCO2'], ['PACO', 'PACO2'], ['PvCO', 'PvCO2'], ['PtcCO', 'PtcCO2'],
  ['PaO', 'PaO2'], ['PAO', 'PAO2'], ['PvO', 'PvO2'], ['PtcO', 'PtcO2'],
  ['FiO', 'FiO2'], ['FIO', 'FIO2'], ['FeO', 'FeO2'],
  ['SpO', 'SpO2'], ['SaO', 'SaO2'], ['SvO', 'SvO2'], ['ScvO', 'ScvO2'],
  ['CaO', 'CaO2'], ['CvO', 'CvO2'], ['DO', 'DO2'], ['VO', 'VO2'], ['VCO', 'VCO2'],
  ['HCO', 'HCO3'],
  ['Pco', 'Pco2'], ['PCO', 'PCO2'], ['Pao', 'Pao2'], ['Paco', 'Paco2'],
  ['H O', 'H2O'], ['HO', 'H2O'],
];

// token 前後都必須不是英數，否則像 "VOR gain…2" 會被誤判成 VO2R（2026-09-11 dry-run 抓到）
const L = '(?<![A-Za-z0-9])';
const R = '(?![A-Za-z0-9])';

// 類型1：token 後面隔著空白就接下標數字 → 直接黏回去
function fixAdjacent(text) {
  // "H 2 O 2"（雙氧水）要先於 H2O 處理，否則只黏前半段、後面留下孤立的 " 2"
  let out = text.replace(new RegExp(L + 'H\\s*2\\s*O\\s*2' + R, 'g'), 'H2O2');
  // "H 2 O" / "cmH 2 O" 這種下標被空格拆開的再正規化
  out = out.replace(new RegExp(L + 'H\\s+2\\s*O' + R, 'g'), 'H2O');
  for (const [bad, good] of TOKENS) {
    // H2O 的下標在中間，緊鄰樣態是 "H O" / "HO" 後面接 2
    const digit = good.match(/\d/)[0];
    const re = new RegExp(L + escape(bad) + '\\s*' + digit + R, 'g');
    out = out.replace(re, good);
  }
  return out;
}

// 類型2：字串尾端是孤立的下標數字，而前面有個缺下標的 token → 把數字搬回去
function fixTrailing(text) {
  const m = text.match(/^(.*?)\s*([23])\s*$/s);
  if (!m) return text;
  const [, body, digit] = m;
  for (const [bad, good] of TOKENS) {
    if (!good.includes(digit)) continue;
    // token 前後不可以是英數（已有下標、或只是某個單字的一段，如 VOR）
    const re = new RegExp(L + escape(bad) + R);
    if (re.test(body)) return body.replace(re, good);
  }
  return text;
}

function escape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function fixText(text) {
  if (typeof text !== 'string') return text;
  let out = fixAdjacent(text);
  out = fixTrailing(out);
  return out;
}

module.exports = { fixText };
if (require.main !== module) return;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const only = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;

const files = fs.readdirSync(DIR)
  .filter(f => /^questions-.*\.json$/.test(f) && !/\.bak/.test(f))
  .filter(f => !only || f === `questions-${only}.json`);

let totalQ = 0, totalField = 0;
const preview = [];

for (const file of files) {
  let json;
  try { json = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')); } catch { continue; }
  const arr = Array.isArray(json) ? json : json.questions;
  if (!arr) continue;

  let changedQ = 0;
  for (const q of arr) {
    let touched = false;
    const before = { q: q.question, o: { ...(q.options || {}) } };

    const nq = fixText(q.question);
    if (nq !== q.question) { q.question = nq; totalField++; touched = true; }

    if (q.options) {
      for (const k of Object.keys(q.options)) {
        const nv = fixText(q.options[k]);
        if (nv !== q.options[k]) { q.options[k] = nv; totalField++; touched = true; }
      }
    }
    if (touched) {
      changedQ++;
      if (preview.length < 15) {
        const diffs = [];
        if (before.q !== q.question) diffs.push(['題幹', before.q, q.question]);
        for (const k of Object.keys(q.options || {})) {
          if (before.o[k] !== q.options[k]) diffs.push([k, before.o[k], q.options[k]]);
        }
        preview.push({ file, id: q.id, where: `${q.roc_year}${q.session} #${q.number}`, diffs });
      }
    }
  }

  if (changedQ) {
    totalQ += changedQ;
    console.log(`${file.replace('questions-', '').replace('.json', '').padEnd(22)} ${changedQ} 題`);
    if (APPLY) fs.writeFileSync(path.join(DIR, file), JSON.stringify(json, null, 2), 'utf8');
  }
}

console.log(`\n總計：${totalQ} 題 / ${totalField} 個欄位`);

if (preview.length) {
  console.log('\n─── 修改樣本 ───');
  for (const p of preview) {
    console.log(`[${p.file.replace('questions-', '').replace('.json', '')} ${p.id} ${p.where}]`);
    for (const [k, a, b] of p.diffs) {
      console.log(`  ${k}  ${JSON.stringify(a)}`);
      console.log(`  ${' '.repeat(k.length)}→ ${JSON.stringify(b)}`);
    }
  }
}

console.log(APPLY ? '\n✅ 已寫回檔案' : '\n(dry-run，加 --apply 才會寫入)');
