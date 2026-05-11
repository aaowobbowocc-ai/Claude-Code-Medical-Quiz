// 找 user reports 對應到的 shared-banks 或特殊 ID 題目
const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
const EXAM_FILES = {
  doctor1: 'questions.json', doctor2: 'questions-doctor2.json',
  dental1: 'questions-dental1.json', dental2: 'questions-dental2.json',
  pharma1: 'questions-pharma1.json', pharma2: 'questions-pharma2.json',
  nursing: 'questions-nursing.json', nutrition: 'questions-nutrition.json',
  medlab: 'questions-medlab.json', pt: 'questions-pt.json', ot: 'questions-ot.json',
  radiology: 'questions-radiology.json', tcm1: 'questions-tcm1.json',
  tcm2: 'questions-tcm2.json', vet: 'questions-vet.json',
  audiologist: 'questions-audiologist.json',
  'speech-therapist': 'questions-speech-therapist.json',
  rt: 'questions-rt.json',
  'social-worker': 'questions-social-worker.json',
};

// 載入所有
const all = [];
for (const [exam, file] of Object.entries(EXAM_FILES)) {
  const fp = path.join(BACKEND, file);
  if (!fs.existsSync(fp)) continue;
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  const arr = data.questions || data;
  for (const q of arr) all.push({ exam, q });
}

// shared-banks
const sbDir = path.join(BACKEND, 'shared-banks');
if (fs.existsSync(sbDir)) {
  for (const f of fs.readdirSync(sbDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(sbDir, f), 'utf-8'));
      const arr = data.questions || data;
      if (!Array.isArray(arr)) continue;
      for (const q of arr) all.push({ exam: 'shared:' + f.replace(/\.json$/, ''), q });
    } catch {}
  }
}

console.log('Total indexed:', all.length, 'questions');

// 嘗試
const lookups = [
  { qid: '3153_paper5', hint: '讚讚蹦蹦 108-2 Q76 a選項有缺漏' },
  { qid: '112030_psych_community_40_paper5', hint: 'garfield 112-1 Q40 答案應為D' },
  { qid: '5586_paper4', hint: '讚讚蹦蹦 106-1 Q68 題目不完整 (chromoblastomycosis)' },
  { qid: '2027_paper2', hint: '讚讚蹦蹦 110-2 Q28 110年臨床生理學病理學顯示成臨床血液學' },
  { qid: '109100_s33_39_paper3', hint: '🌙 109-2 Q39 答案有誤' },
];

for (const { qid, hint } of lookups) {
  console.log('═════════════════════════════════════════════════════');
  console.log('Lookup:', qid, '|', hint);

  // 1. 直接 id 比對
  const exact = all.filter(({ q }) => String(q.id) === qid);
  if (exact.length) {
    console.log('  ✓ EXACT match:', exact.length);
    for (const m of exact.slice(0, 2)) console.log('    →', m.exam, '/', m.q.subject || m.q.subject_name, '/', (m.q.question || '').slice(0, 60));
    continue;
  }

  // 2. id contains qid
  const contains = all.filter(({ q }) => String(q.id).includes(qid) || qid.includes(String(q.id)));
  if (contains.length && contains.length < 5) {
    console.log('  ~ partial id match:', contains.length);
    for (const m of contains.slice(0, 3)) console.log('    →', m.exam, '|', m.q.id, '|', (m.q.question || '').slice(0, 60));
  }
}
