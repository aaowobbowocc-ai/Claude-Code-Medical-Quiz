#!/usr/bin/env node
/**驗收批量修復結果*/

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const EXAMS = [
  { file: 'questions-pharma1.json', name: 'pharma1' },
  { file: 'questions-nursing.json', name: 'nursing' },
  { file: 'questions-radiology.json', name: 'radiology' }
];

console.log('\n=== 驗收批量修復結果 ===\n');

const before = {
  pharma1: 79,
  nursing: 57,
  radiology: 45
};

EXAMS.forEach(e => {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, e.file), 'utf-8'));
    const q = data.questions || data;
    const incomp = q.filter(x => x.incomplete).length;
    
    const fixed = before[e.name] - incomp;
    const pct = Math.round(fixed * 100 / before[e.name]);
    
    console.log(`${e.name.padEnd(15)} ${incomp.toString().padStart(3)} incomplete  |  ${fixed} fixed (${pct}%)`);
  } catch(err) {
    console.log(`${e.name.padEnd(15)} ERROR`);
  }
});
