#!/usr/bin/env node
/**
 * Re-extract images for doctor2 110080 (110年第二次)
 * with improved white-border trimming
 */

const path = require('path');
const fs = require('fs');
const { extractSession } = require('./extract-images-v3');

// Doctor2 110年第二次 (110080) — class code 301, subjects by paper
// Paper: 醫學(三) 醫學(四) 醫學(五) 醫學(六) (4 papers, c=301)
const DOCTOR2_110080 = {
  exam: 'doctor2',
  code: '110080',
  papers: [
    { c: '301', s: '0301' },  // 醫學(三)
    { c: '301', s: '0401' },  // 醫學(四)
    { c: '301', s: '0501' },  // 醫學(五)
    { c: '301', s: '0601' },  // 醫學(六) ← User reported image issue here
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
