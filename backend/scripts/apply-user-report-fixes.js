// 套用使用者回報修正
const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
const fixes = [
  {
    file: 'questions.json',
    qid: 1150203572,
    changes: { subject_tag: 'public_health', subject_name: '公共衛生學' },
    reason: '啊啊啊回報：醫療法題目分類應為公衛而非生物化學',
  },
  {
    file: 'questions.json',
    qid: 1150203084,
    changes: { disputed: true },
    reason: '楊迪欣回報：選項文字被切（含 ①②③④ 但只看到部分）',
  },
  {
    file: 'questions-medlab.json',
    qid: '5586',
    changes: { disputed: true },
    reason: '讚讚蹦蹦回報 106-1 微生物 Q68：題目不完整 (chromoblastomycosis)',
  },
  {
    file: 'questions-nursing.json',
    qid: '3153',
    changes: { disputed: true },
    reason: '讚讚蹦蹦回報 108-2 精神科 Q76：a選項有缺漏',
  },
  {
    file: 'questions-nursing.json',
    qid: '112030_psych_community_40',
    changes: { disputed: true },
    reason: 'garfield 回報 112-1 精神科 Q40：答案有誤應為D（current 已是 D，使用者可能看到 cache 舊版）',
  },
];

let totalChanged = 0;
const grouped = new Map();
for (const f of fixes) {
  if (!grouped.has(f.file)) grouped.set(f.file, []);
  grouped.get(f.file).push(f);
}

for (const [file, items] of grouped) {
  const fp = path.join(BACKEND, file);
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  const arr = data.questions || data;
  let changed = 0;
  for (const item of items) {
    const q = arr.find(x => String(x.id) === String(item.qid));
    if (!q) { console.log('  NOT FOUND', item.qid); continue; }
    let touched = false;
    for (const [k, v] of Object.entries(item.changes)) {
      if (q[k] !== v) { q[k] = v; touched = true; }
    }
    if (touched) {
      changed++;
      console.log('  ✓', item.qid, '|', JSON.stringify(item.changes), '|', item.reason);
    } else {
      console.log('  - already', item.qid);
    }
  }
  if (changed > 0) {
    fs.writeFileSync(fp, JSON.stringify(data));
    console.log(file, ':', changed, 'changes saved');
    totalChanged += changed;
  }
}
console.log('\nTotal applied:', totalChanged);
