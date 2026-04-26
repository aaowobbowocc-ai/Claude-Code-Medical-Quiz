#!/usr/bin/env node
/**
 * Re-extract images for doctor2 110080 (110年第二次)
 * with improved white-border trimming
 */

const path = require('path');
const fs = require('fs');
const { extractSession } = require('./extract-images-v3');

// Doctor2 110年第二次 (110080) — class code 301, 2-digit s codes
// Paper: 醫學(三) 醫學(四) 醫學(五) 醫學(六) (4 papers, c=301)
const DOCTOR2_110080 = {
  exam: 'doctor2',
  code: '110080',
  papers: [
    { c: '302', s: '11' },  // 醫學(三) internal_medicine
    { c: '302', s: '22' },  // 醫學(四) pediatrics
    { c: '302', s: '33' },  // 醫學(五) surgery
    { c: '302', s: '44' },  // 醫學(六) medical_law_ethics ← User reported image issue here
  ],
};

(async () => {
  console.log(`\n=== Re-extracting doctor2 110080 Images (with white-border trimming) ===\n`);

  try {
    const result = await extractSession(DOCTOR2_110080, { dryRun: false });

    console.log('\n=== Extraction Complete ===\n');
    for (const [paperIdx, mapping] of Object.entries(result)) {
      const paperNames = ['醫學(三)', '醫學(四)', '醫學(五)', '醫學(六)'];
      console.log(`Paper ${parseInt(paperIdx)+1} (${paperNames[paperIdx]}): ${Object.keys(mapping).length} questions with images`);
      const qNums = Object.keys(mapping).map(Number).sort((a,b) => a-b);
      if (qNums.length > 0) {
        console.log(`  Questions: ${qNums.slice(0, 5).join(', ')}${qNums.length > 5 ? `, ... (+${qNums.length - 5} more)` : ''}`);
      }
    }

    console.log(`\n✓ Done. Images are in frontend/public/question-images/`);
    process.exit(0);
  } catch (e) {
    console.error(`\n✗ Error: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  }
})();
