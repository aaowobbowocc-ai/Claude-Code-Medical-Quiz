// 一次性 triage 工具，看 user-reported reports 對應到哪些題目
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

const idIndex = new Map();
for (const [exam, file] of Object.entries(EXAM_FILES)) {
  const fp = path.join(BACKEND, file);
  if (!fs.existsSync(fp)) continue;
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  const arr = data.questions || data;
  for (const q of arr) idIndex.set(String(q.id), { exam, q });
}

const reports = [
  ['1150203060', '可口的麵包 109-1 Q75', 'b也可以'],
  ['1150204123', '張晏方 103-2 Q38', '終端小支氣管不具氣體交換'],
  ['1150204258', '張晏方 103-2 Q74', '答案錯誤 正確答案應是C嗜睡'],
  ['1150204280', '啊啊啊 103-2 Q96', '答案給錯'],
  ['1150204390', '啊啊啊 104-1 Q6', '選項應該有缺漏'],
  ['1150203572', '啊啊啊 101-1 Q85', '這題分類應該是公衛吧'],
  ['1150204149', '醬板鴨 103-2 Q64', '答案是class switch'],
  ['1150203084', '楊迪欣 109-1 Q99', '選項有誤'],
  ['1150203282', '楊迪欣 109-2 Q99', '選項有誤'],
  ['102110_0205_38', 'AAO 102-1 Q38', '題目選項都壞了'],
  ['3153_paper5', 'garfield 108-2 Q76', 'a選項有缺漏'],
  ['112030_psych_community_40_paper5', 'garfield 112-1 Q40', '答案有誤，應為D'],
  ['5586_paper4', '讚讚蹦蹦 106-1 Q68', '題目不完整'],
  ['2027_paper2', '讚讚蹦蹦 110-2 Q28', '110年臨床生理學與病理學 顯示成 臨床血液學'],
  ['109100_s33_39_paper3', '🌙 109-2 Q39', '答案有誤'],
];

for (const [qid, where, note] of reports) {
  const m = idIndex.get(qid);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('QID', qid, '|', where);
  console.log('NOTE:', note);
  if (!m) { console.log('  ✗ NOT FOUND'); continue; }
  const q = m.q;
  console.log('  exam=' + m.exam + ' | subject=' + q.subject + ' | tag=' + q.subject_tag + ' | name=' + q.subject_name);
  console.log('  Q:', (q.question || '').slice(0, 120));
  for (const [k, v] of Object.entries(q.options || {})) {
    console.log('    ' + k + '. ' + (v || '').slice(0, 80));
  }
  console.log('  ANSWER:', q.answer, '| disputed:', q.disputed || false);
}
