#!/usr/bin/env node
/**
 * 對 vision-recheck v2 高風險 mismatches 加 vision_uncertain 標記。
 *
 * 三層：
 *   Tier 1 (PDF ≤5 mismatch): 已套用，不重做（已在 commit 9c2f487 有 disputed:true）
 *   Tier 2 (PDF 6-15 mismatch): apply 答案 + vision_uncertain:true（隔離型錯誤，Vision 可信）
 *   Tier 3 (PDF ≥16 mismatch): 只 vision_uncertain:true，不改答案（off-by-1 系統性 bug，
 *                              需重爬 PDF 之後再修，先讓 UI 顯示警告）
 *
 * Usage:
 *   node scripts/apply-vision-uncertain.js [--dry]
 */
const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
const LOG = path.join(BACKEND, '_tmp', 'vision-recheck-v2-log.json');
const dry = process.argv.includes('--dry');

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

const log = JSON.parse(fs.readFileSync(LOG, 'utf-8'));
const mc = {};
for (const m of log.full) mc[m.source] = (mc[m.source] || 0) + 1;

const tier2 = log.full.filter(m => mc[m.source] >= 6 && mc[m.source] <= 15);
const tier3 = log.full.filter(m => mc[m.source] >= 16);

console.log(`Tier 2 (apply + uncertain): ${tier2.length} mismatches`);
console.log(`Tier 3 (uncertain only):    ${tier3.length} mismatches`);

// group by exam
const byExam = {};
function add(exam, m, applyAnswer) {
  if (!byExam[exam]) byExam[exam] = [];
  byExam[exam].push({ ...m, applyAnswer });
}
for (const m of tier2) add(m.examId, m, true);
for (const m of tier3) add(m.examId, m, false);

let totalChanged = 0;
let totalApplied = 0;
let totalUncertainAdded = 0;
for (const [exam, items] of Object.entries(byExam)) {
  const file = EXAM_FILES[exam];
  if (!file) { console.log(`[${exam}] no file mapped`); continue; }
  const fp = path.join(BACKEND, file);
  if (!fs.existsSync(fp)) { console.log(`[${exam}] ${file} not found`); continue; }
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  const arr = data.questions || data;
  const idIndex = new Map();
  for (const q of arr) idIndex.set(String(q.id), q);

  let changed = 0, applied = 0, uncertain = 0, missing = 0;
  for (const item of items) {
    const q = idIndex.get(String(item.qid));
    if (!q) { missing++; continue; }
    let touched = false;
    // 補 vision_uncertain
    if (!q.vision_uncertain) {
      if (!dry) q.vision_uncertain = true;
      uncertain++; touched = true;
    }
    // Tier 2 apply 新答案
    if (item.applyAnswer && q.answer !== item.new && /^[ABCD]$/.test(item.new)) {
      if (!dry) q.answer = item.new;
      applied++; touched = true;
    }
    if (touched) changed++;
  }
  console.log(`[${exam}] uncertain+=${uncertain} answer-applied=${applied} missing=${missing}`);
  totalChanged += changed; totalApplied += applied; totalUncertainAdded += uncertain;
  if (!dry && changed > 0) fs.writeFileSync(fp, JSON.stringify(data));
}

console.log(`\n=== Total: ${totalChanged} questions touched ===`);
console.log(`  - vision_uncertain added: ${totalUncertainAdded}`);
console.log(`  - answers applied (Tier 2): ${totalApplied}`);
if (dry) console.log('(DRY-RUN — 加 --apply 為實際變更)');
