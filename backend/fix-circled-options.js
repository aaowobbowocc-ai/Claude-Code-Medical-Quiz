#!/usr/bin/env node
/**
 * 修復 incomplete=true gap_reason=parser_circled_number_collision 的題目
 * 透過視覺辨識的選項數據，覆寫 options 並移除 incomplete 旗標
 */
const fs = require('fs');
const path = require('path');

const FIXES = {
  tcm1: {
    1619: { A: '①③⑤⑧', B: '①④⑥⑧', C: '②③⑥⑦', D: '②④⑥⑦' },
    1658: { A: '①②③④', B: '②③①④', C: '③②④①', D: '④②①③' },
    1681: { A: '①②③', B: '②③④', C: '①③④', D: '①②④' },
    1702: { A: '僅①②', B: '僅①③', C: '僅②③', D: '①②③' },
    1710: { A: '①③', B: '②④', C: '①②', D: '③④' },
    1718: { A: '①②', B: '①③', C: '②③', D: '③④' },
    1730: { A: '①②③', B: '①③④', C: '②③④', D: '①②④' },
    3751: { A: '①②', B: '①③', C: '②④', D: '③④' },
    3754: { A: '①②③', B: '①②④', C: '①③④', D: '②③④' },
    3765: { A: '①③', B: '①②', C: '②③', D: '①②③' },
  },
  nursing: {
    1049: { A: '①②③', B: '①②④', C: '①③④', D: '②③④' },
    1053: { A: '①②', B: '①③', C: '②④', D: '③④' },
    1066: { A: '①②', B: '①④', C: '②③', D: '③④' },
    979:  { A: '①②', B: '①③', C: '②④', D: '③④' },
    982:  { A: '①③', B: '②⑤', C: '③④', D: '③⑤' },
    985:  { A: '①③④', B: '①③⑤', C: '②③④', D: '②④⑤' },
    1007: { A: '①②④', B: '②③⑤', C: '①④⑤', D: '②③④' },
    1121: { A: '①④⑤', B: '①③④', C: '②④⑤', D: '②③④' },
    1134: { A: '①②③', B: '②③④', C: '③④⑤', D: '①③⑤' },
    1194: { A: '①②④⑤⑥', B: '①②③⑤⑥', C: '①③④⑤⑦', D: '②③④⑥⑦' },
    1199: { A: '①②③', B: '①②④', C: '①③④', D: '②③④' },
    1202: { A: '①②③', B: '①②④', C: '①③④', D: '②③④' },
    1204: { A: '①②③', B: '①②④', C: '①③④', D: '②③④' },
    1217: { A: '①②③', B: '②③④', C: '①③④', D: '①②④' },
    1256: { A: '①②', B: '②③', C: '③④', D: '①③' },
    1270: { A: '①②', B: '①③', C: '②③', D: '②④' },
    1271: { A: '①②', B: '①④', C: '②③', D: '③④' },
    1545: { A: '①②', B: '③④', C: '①④', D: '②③' },
    1633: { A: '①④', B: '②⑤', C: '③⑥', D: '②⑥' },
    1651: { A: '①②③', B: '②③④', C: '②④⑤', D: '③④⑤' },
    1658: { A: '①②③', B: '①③④', C: '②③④', D: '②④⑤' },
    1758: { A: '①②③', B: '①②④', C: '①②⑤', D: '③④⑤' },
    1771: { A: '①②', B: '②③', C: '③④', D: '①④' },
    1937: { A: '①③', B: '①②', C: '②③', D: '②④' },
    2103: { A: '①③④', B: '②③⑤', C: '①④⑤', D: '①③⑤' },
    2168: { A: '①③④', B: '②③④', C: '①②④', D: '①②③' },
    2171: { A: '①②', B: '②③', C: '③④', D: '①③' },
    2227: { A: '①②③', B: '①②④', C: '①③④', D: '②③④' },
    2416: { A: '①②③', B: '①②④', C: '②③④', D: '①③④' },
    2432: { A: '僅①②', B: '僅③⑤', C: '①②③', D: '②③④' },
    2450: { A: '①②③', B: '②③④', C: '③④⑤', D: '①③⑤' },
    2637: { A: '①③④', B: '①⑤⑥', C: '②③⑤', D: '②④⑥' },
    2642: { A: '①②', B: '①③', C: '②④', D: '③④' },
    3140: { A: '①②', B: '②④', C: '①③', D: '④⑤' },
    3325: { A: '①②③', B: '①②④', C: '①③④', D: '②③④' },
    3334: { A: '①②③', B: '①②④', C: '①③④', D: '②③④' },
    3379: { A: '①③', B: '①④', C: '②③', D: '②④' },
  },
  nutrition: {
    2103: { A: '①②③', B: '②③④', C: '①②⑤', D: '①④⑤' },
    2332: { A: '①②', B: '②③', C: '③④', D: '①④' },
    2339: { A: '僅①②', B: '僅③④', C: '①②④', D: '①③④' },
    2355: { A: '①③⑥⑧⑨', B: '②③④⑤⑦', C: '①③④⑥⑩', D: '①④⑦⑧⑨' },
  },
  'social-worker': {
    628:  { A: '①②③④⑤⑥', B: '①④③②⑤⑥', C: '①③④②⑤⑥', D: '①③②⑤④⑥' },
    886:  { A: '①②③④⑤', B: '⑤③④②①', C: '①②③⑤④', D: '②①③⑤④' },
    887:  { A: '①③', B: '①②', C: '①③④', D: '①④' },
    910:  { A: '②③④', B: '①②③', C: '①③④', D: '①②③④' },
    911:  { A: '②③④', B: '①②④', C: '①③④', D: '①②③' },
    913:  { A: '①②③④', B: '②③④⑤', C: '①②③④⑤', D: '①②④⑤' },
    914:  { A: '②③④', B: '①②③④', C: '①③④', D: '①②③' },
    1080: { A: '①②③', B: '②③④', C: '①②④', D: '①③④' },
    1081: { A: '①②③', B: '②③④', C: '①②④', D: '①③④' },
  },
  doctor1: {
    1150204361: { A: '僅①②', B: '僅①③', C: '僅②③', D: '①②③' },
    1150204362: { A: '僅①②', B: '僅①③', C: '僅②③', D: '①②③' },
    1150204376: { A: '①②③', B: '①③②', C: '②①③', D: '③②①' },
  },
  doctor2: {
    115025800: { A: '①②③④⑤', B: '僅①②④⑤', C: '僅①③④', D: '僅②③⑤' },
    115025816: { A: '①②④', B: '①③⑤', C: '①③④', D: '②③④' },
  },
  tcm2: {
    6396: { A: '表示其氣盛而胃中寒者', B: '表示其氣盛而胃中熱者', C: '其診斷理論基礎為察經脈之色診病', D: '其診斷理論基礎為察絡脈之色診病' },
  },
};

const FILE_MAP = {
  tcm1: 'questions-tcm1.json',
  tcm2: 'questions-tcm2.json',
  doctor1: 'questions.json',
  doctor2: 'questions-doctor2.json',
  nursing: 'questions-nursing.json',
  nutrition: 'questions-nutrition.json',
  'social-worker': 'questions-social-worker.json',
};

function applyFixes(examId, dryRun = false) {
  const file = FILE_MAP[examId];
  const fixes = FIXES[examId] || {};
  const fixIds = Object.keys(fixes).map(Number);
  if (fixIds.length === 0) return { fixed: 0, skipped: 0 };

  const fp = path.join(__dirname, file);
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  const qs = data.questions || data;

  let fixed = 0;
  for (const q of qs) {
    if (!fixes[q.id]) continue;
    const newOpts = fixes[q.id];
    q.options.A = newOpts.A;
    q.options.B = newOpts.B;
    q.options.C = newOpts.C;
    q.options.D = newOpts.D;
    delete q.incomplete;
    delete q.gap_reason;
    fixed++;
  }

  if (!dryRun) {
    fs.writeFileSync(fp, JSON.stringify(data, null, 2));
  }
  return { fixed };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const examFilter = args.find(a => !a.startsWith('--'));

  const exams = examFilter ? [examFilter] : Object.keys(FIXES);
  let total = 0;
  for (const ex of exams) {
    if (!FIXES[ex] || Object.keys(FIXES[ex]).length === 0) continue;
    const r = applyFixes(ex, dryRun);
    console.log(`${ex}: ${r.fixed} fixed${dryRun ? ' (dry-run)' : ''}`);
    total += r.fixed;
  }
  console.log(`\nTotal: ${total} questions restored`);
}

module.exports = { applyFixes, FIXES, FILE_MAP };
