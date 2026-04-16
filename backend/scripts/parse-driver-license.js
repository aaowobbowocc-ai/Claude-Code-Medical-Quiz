#!/usr/bin/env node
/**
 * parse-driver-license.js — 解析公路局駕照題庫 PDF → JSON
 *
 * 輸入：backend/_driver_license/ 下的 PDF 檔
 * 輸出：backend/questions-driver-car.json, backend/questions-driver-moto.json
 *
 * 題型：
 *   - 三選一選擇題 (1)(2)(3) → 對應 A/B/C
 *   - 是非題 ○/X → 對應 A(○正確)/B(✕錯誤)
 *
 * 駕照特殊規則：
 *   - 85 分及格（不是 60 分）
 *   - 固定題庫（無年度維度）
 *   - 三選一（不是四選一）
 *   - 含是非題
 */
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

const DIR = path.resolve(__dirname, '..', '_driver_license');
const OUT = path.resolve(__dirname, '..');

// ─── helpers ───

function cleanLine(s) {
  return s.replace(/\s+/g, ' ').trim();
}

// ─── 機車題庫 parser (804 題, 三選一) ───
// Format: "題號\n答案\n題目\n(1)...(2)...(3)..."
// OR inline: "題號 答案 題目\n(1)...(2)...(3)..."
// State machine: EXPECT_NUM → EXPECT_ANS → COLLECT_TEXT → done
async function parseMoto() {
  const buf = fs.readFileSync(path.join(DIR, 'moto_all_804.pdf'));
  const { text } = await pdfParse(buf);
  const rawLines = text.split('\n');

  const questions = [];
  let nextExpectedNum = 1;
  let state = 'EXPECT_NUM'; // EXPECT_NUM, EXPECT_ANS, COLLECT_TEXT
  let curQ = null;

  function isHeader(line) {
    return /機車駕照筆試題庫/.test(line)
      || /^—\s*\d+\s*—$/.test(line)
      || /^題號\s+答案\s+題目內容/.test(line)
      || /^【\s*題庫索引\s*】/.test(line)
      || /^━+$/.test(line);
  }

  function isSkippablePreamble(line) {
    return /^分類\s*$/.test(line)
      || /^(正確觀念與態度|主動停讓文化|安全駕駛能力)\s*$/.test(line);
  }

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    if (!line) continue;
    if (isHeader(line)) continue;
    if (nextExpectedNum <= 1 && isSkippablePreamble(line)) continue;

    if (state === 'EXPECT_NUM') {
      // Try inline: "題號 答案 題目..." (with text after answer)
      const inlineMatch = line.match(/^(\d{1,3})\s+([123])\s+(.+)$/);
      if (inlineMatch && parseInt(inlineMatch[1]) === nextExpectedNum) {
        if (curQ) questions.push(finalizeQ(curQ));
        curQ = {
          number: nextExpectedNum,
          answer: inlineMatch[2],
          questionText: inlineMatch[3],
          options: [],
        };
        extractInlineOptions(curQ);
        state = 'COLLECT_TEXT';
        nextExpectedNum++;
        continue;
      }

      // Try "題號 答案" (no text after answer, e.g. "539 3 ")
      const numAnsMatch = line.match(/^(\d{1,3})\s+([123])\s*$/);
      if (numAnsMatch && parseInt(numAnsMatch[1]) === nextExpectedNum) {
        if (curQ) questions.push(finalizeQ(curQ));
        curQ = {
          number: nextExpectedNum,
          answer: numAnsMatch[2],
          questionText: '',
          options: [],
        };
        state = 'COLLECT_TEXT';
        nextExpectedNum++;
        continue;
      }

      // Try standalone number
      const numMatch = line.match(/^(\d{1,3})\s*$/);
      if (numMatch && parseInt(numMatch[1]) === nextExpectedNum) {
        if (curQ) questions.push(finalizeQ(curQ));
        curQ = {
          number: nextExpectedNum,
          answer: null,
          questionText: '',
          options: [],
        };
        state = 'EXPECT_ANS';
        nextExpectedNum++;
        continue;
      }

      // Not a question number — if we're collecting text for curQ, append
      if (curQ) {
        appendToQ(curQ, line);
      }
      // Otherwise skip (preamble text like sub-category headers)
      continue;
    }

    if (state === 'EXPECT_ANS') {
      const ansMatch = line.match(/^([123])\s*$/);
      if (ansMatch) {
        curQ.answer = ansMatch[1];
        state = 'COLLECT_TEXT';
        continue;
      }
      // Answer + text inline: "2 機車附載..."
      const ansTextMatch = line.match(/^([123])\s+(.+)$/);
      if (ansTextMatch) {
        curQ.answer = ansTextMatch[1];
        curQ.questionText = ansTextMatch[2];
        extractInlineOptions(curQ);
        state = 'COLLECT_TEXT';
        continue;
      }
      // Sometimes the answer is missing and we're already on question text
      // (e.g., image-based questions with no text). Treat this line as text.
      curQ.answer = null;
      state = 'COLLECT_TEXT';
      appendToQ(curQ, line);
      continue;
    }

    if (state === 'COLLECT_TEXT') {
      // Check if this line starts the NEXT question
      const nextInline = line.match(/^(\d{1,3})\s+([123])\s+(.+)$/);
      if (nextInline && parseInt(nextInline[1]) === nextExpectedNum) {
        questions.push(finalizeQ(curQ));
        curQ = {
          number: nextExpectedNum,
          answer: nextInline[2],
          questionText: nextInline[3],
          options: [],
        };
        extractInlineOptions(curQ);
        nextExpectedNum++;
        continue;
      }

      // "題號 答案" without text
      const nextNumAns = line.match(/^(\d{1,3})\s+([123])\s*$/);
      if (nextNumAns && parseInt(nextNumAns[1]) === nextExpectedNum) {
        questions.push(finalizeQ(curQ));
        curQ = {
          number: nextExpectedNum,
          answer: nextNumAns[2],
          questionText: '',
          options: [],
        };
        nextExpectedNum++;
        continue;
      }

      const nextNum = line.match(/^(\d{1,3})\s*$/);
      if (nextNum && parseInt(nextNum[1]) === nextExpectedNum) {
        questions.push(finalizeQ(curQ));
        curQ = { number: nextExpectedNum, answer: null, questionText: '', options: [] };
        state = 'EXPECT_ANS';
        nextExpectedNum++;
        continue;
      }

      // Otherwise append to current question
      appendToQ(curQ, line);
      continue;
    }
  }
  if (curQ) questions.push(finalizeQ(curQ));

  console.log(`[機車] parsed ${questions.length} questions`);
  return questions;
}

function appendToQ(q, line) {
  // Normalize all paren+digit variants to half-width
  line = normalizeParens(line);
  // Option lines: (1)...(2)...(3)... possibly mixed with question text
  if (/\([123]\)/.test(line)) {
    // Check if there's question text before the first (1)
    const idx1 = line.indexOf('(1)');
    if (idx1 > 0 && q.options.length === 0 && !q.questionText) {
      q.questionText = line.slice(0, idx1).trim();
      line = line.slice(idx1);
    }
    const parts = line.split(/(?=\([123]\))/);
    for (const p of parts) {
      const m = p.match(/^\(([123])\)\s*(.*)$/);
      if (m) {
        const existing = q.options.find(o => o.num === m[1]);
        if (existing) {
          existing.text += m[2];
        } else {
          q.options.push({ num: m[1], text: m[2] });
        }
      } else if (q.options.length === 0 && p.trim()) {
        q.questionText += p.trim();
      } else if (q.options.length > 0 && p.trim()) {
        q.options[q.options.length - 1].text += p.trim();
      }
    }
    return;
  }

  // Pure continuation text
  if (q.options.length > 0) {
    q.options[q.options.length - 1].text += line;
  } else {
    if (q.questionText) q.questionText += line;
    else q.questionText = line;
  }
}

function extractInlineOptions(q) {
  // Normalize full-width parens first
  q.questionText = normalizeParens(q.questionText);
  // Check if question text has embedded options like "...(1)...(2)...(3)..."
  const text = q.questionText;
  const firstOpt = text.indexOf('(1)');
  if (firstOpt > 0) {
    const qText = text.slice(0, firstOpt).trim();
    const optsPart = text.slice(firstOpt);
    q.questionText = qText;
    const parts = optsPart.split(/(?=\([123]\))/);
    for (const p of parts) {
      const m = p.match(/^\(([123])\)\s*(.*)$/);
      if (m) q.options.push({ num: m[1], text: m[2].trim() });
    }
  }
}

function finalizeQ(q) {
  // Clean up
  q.questionText = cleanLine(q.questionText);
  const opts = {};
  const ansMap = { '1': 'A', '2': 'B', '3': 'C' };
  for (const o of q.options) {
    const key = ansMap[o.num] || o.num;
    opts[key] = cleanLine(o.text).replace(/。$/, '').replace(/\.$/, '');
  }
  return {
    number: q.number,
    answer: ansMap[q.answer] || q.answer,
    question: q.questionText,
    options: opts,
    category: q.category,
    subCategory: q.subCategory,
  };
}

// ─── 汽車法規選擇題 parser ───
async function parseCarChoice() {
  const buf = fs.readFileSync(path.join(DIR, 'car_rules_choice.pdf'));
  const { text } = await pdfParse(buf);
  const rawLines = text.split('\n');

  const questions = [];
  let curQ = null;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    if (!line) continue;

    // Skip headers
    if (/^汽車法規選擇題/.test(line)) continue;
    if (/^第\d+頁/.test(line)) continue;
    if (/^題號\s+答案\s+題/.test(line)) continue;
    if (/^分類編號欄位說明/.test(line)) continue;
    if (/^分類編$/.test(line)) continue;
    if (/^號\s*$/.test(line)) continue;
    if (/^分類項目內容/.test(line)) continue;
    if (/^\d{2}\s+[\u4e00-\u9fff]/.test(line) && line.length < 60 && /[\(（]/.test(line) === false) continue; // category header like "01  路口安全..."
    if (/^分類$/.test(line)) continue;
    if (/^編號\s*$/.test(line)) continue;

    // Question line: "001  3  題目文字..."
    const qMatch = line.match(/^(\d{3})\s+([123])\s+(.*)$/);
    if (qMatch) {
      if (curQ) questions.push(finalizeCarChoice(curQ));
      curQ = {
        number: parseInt(qMatch[1]),
        answer: qMatch[2],
        textParts: [qMatch[3]],
      };
      continue;
    }

    // Question number + answer only (split across lines): "001  3"
    const qNumAns = line.match(/^(\d{3})\s+([123])\s*$/);
    if (qNumAns) {
      if (curQ) questions.push(finalizeCarChoice(curQ));
      curQ = {
        number: parseInt(qNumAns[1]),
        answer: qNumAns[2],
        textParts: [],
      };
      continue;
    }

    // Category number at end of question block (standalone "01" to "10")
    if (/^\d{2}\s*$/.test(line) && parseInt(line) >= 1 && parseInt(line) <= 10) {
      // This is the classification number — skip
      continue;
    }

    // Continuation of current question
    if (curQ) {
      curQ.textParts.push(line);
    }
  }
  if (curQ) questions.push(finalizeCarChoice(curQ));

  console.log(`[汽車選擇] parsed ${questions.length} questions`);
  return questions;
}

function normalizeParens(s) {
  // Normalize all paren+digit variants to half-width: （１）→(1), (１)→(1), （1)→(1), etc.
  return s
    .replace(/[（(]\s*([１1])\s*[）)]/g, '(1)')
    .replace(/[（(]\s*([２2])\s*[）)]/g, '(2)')
    .replace(/[（(]\s*([３3])\s*[）)]/g, '(3)');
}

function finalizeCarChoice(q) {
  let fullText = normalizeParens(q.textParts.join(''));
  // Split question text and options
  // Options are (1)...(2)...(3)...
  const firstOpt = fullText.indexOf('(1)');
  let questionText, optText;
  if (firstOpt >= 0) {
    questionText = fullText.slice(0, firstOpt).trim();
    optText = fullText.slice(firstOpt);
  } else {
    questionText = fullText.trim();
    optText = '';
  }

  const opts = {};
  const ansMap = { '1': 'A', '2': 'B', '3': 'C' };
  if (optText) {
    const parts = optText.split(/(?=\([123]\))/);
    for (const p of parts) {
      const m = p.match(/^\(([123])\)\s*(.*)$/);
      if (m) {
        const key = ansMap[m[1]];
        opts[key] = cleanLine(m[2]).replace(/。\s*$/, '').replace(/\.\s*$/, '');
      }
    }
  }

  return {
    number: q.number,
    answer: ansMap[q.answer],
    question: cleanLine(questionText),
    options: opts,
  };
}

// ─── 汽車法規是非題 parser ───
async function parseCarTF() {
  const buf = fs.readFileSync(path.join(DIR, 'car_rules_tf.pdf'));
  const { text } = await pdfParse(buf);
  const rawLines = text.split('\n');

  const questions = [];
  let curQ = null;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    if (!line) continue;

    // Skip headers
    if (/^汽車法規是非題/.test(line)) continue;
    if (/^第\d+頁/.test(line)) continue;
    if (/^題號\s+答案\s+題/.test(line)) continue;
    if (/^分類編號欄位說明/.test(line)) continue;
    if (/^分類編$/.test(line)) continue;
    if (/^號\s*$/.test(line)) continue;
    if (/^分類項目內容/.test(line)) continue;
    if (/^\d{2}\s+[\u4e00-\u9fff]/.test(line) && line.length < 60 && !/[○X]/.test(line)) continue;
    if (/^分類$/.test(line)) continue;
    if (/^編號\s*$/.test(line)) continue;

    // Question with answer on same line: "001  ○  題目..."
    const qMatch = line.match(/^(\d{3})\s+([○X])\s+(.*)$/);
    if (qMatch) {
      if (curQ) questions.push(finalizeTF(curQ));
      curQ = {
        number: parseInt(qMatch[1]),
        answer: qMatch[2],
        textParts: [qMatch[3]],
      };
      continue;
    }

    // Question number + answer only: "001  ○"
    const qNumAns = line.match(/^(\d{3})\s+([○X])\s*$/);
    if (qNumAns) {
      if (curQ) questions.push(finalizeTF(curQ));
      curQ = {
        number: parseInt(qNumAns[1]),
        answer: qNumAns[2],
        textParts: [],
      };
      continue;
    }

    // Classification number (standalone "01" to "10")
    if (/^\d{2}\s*$/.test(line) && parseInt(line) >= 1 && parseInt(line) <= 10) {
      continue;
    }

    if (curQ) {
      curQ.textParts.push(line);
    }
  }
  if (curQ) questions.push(finalizeTF(curQ));

  console.log(`[汽車是非] parsed ${questions.length} questions`);
  return questions;
}

function finalizeTF(q) {
  let questionText = cleanLine(q.textParts.join(''));
  // Strip trailing classification number (e.g. " 10", " 07")
  questionText = questionText.replace(/\s+\d{2}\s*$/, '');
  return {
    number: q.number,
    answer: q.answer === '○' ? 'A' : 'B',
    question: questionText,
    options: { A: '○ (正確)', B: '✕ (錯誤)' },
    type: 'tf',
  };
}

// ─── 汽車標誌是非題 parser ───
async function parseCarSignsTF() {
  const buf = fs.readFileSync(path.join(DIR, 'car_signs_tf.pdf'));
  const { text } = await pdfParse(buf);
  const rawLines = text.split('\n');

  const questions = [];
  let curQ = null;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    if (!line) continue;

    // Skip headers
    if (/汽車標誌/.test(line) && /是非題/.test(line)) continue;
    if (/^第\d+頁/.test(line)) continue;
    if (/^題/.test(line) && /答/.test(line) && /案/.test(line)) continue;
    if (/^分類編號欄位說明/.test(line)) continue;
    if (/^分類編$/.test(line)) continue;
    if (/^號\s*$/.test(line)) continue;
    if (/^分類項目內容/.test(line)) continue;
    if (/^\d{2}\s+[\u4e00-\u9fff]/.test(line) && line.length < 60 && !/[○X]/.test(line)) continue;
    if (/^分類$/.test(line)) continue;
    if (/^編號\s*$/.test(line)) continue;
    if (/^答$/.test(line)) continue;
    if (/^案\s*$/.test(line)) continue;
    if (/題目圖示/.test(line)) continue;

    // Question: "001  ○" or "001  X"
    const qMatch = line.match(/^(\d{3})\s+([○X])\s*(.*)$/);
    if (qMatch) {
      if (curQ) questions.push(finalizeSignsTF(curQ));
      curQ = {
        number: parseInt(qMatch[1]),
        answer: qMatch[2],
        textParts: qMatch[3] ? [qMatch[3]] : [],
      };
      continue;
    }

    // Classification number
    if (/^\d{2}\s*$/.test(line) && parseInt(line) >= 1 && parseInt(line) <= 10) {
      continue;
    }

    if (curQ) {
      curQ.textParts.push(line);
    }
  }
  if (curQ) questions.push(finalizeSignsTF(curQ));

  console.log(`[汽車標誌是非] parsed ${questions.length} questions`);
  return questions;
}

function finalizeSignsTF(q) {
  // 標誌題的文字描述就是「這個標誌是什麼」
  // 由於沒有圖片，題目會是「此標誌為：[描述]」
  const desc = cleanLine(q.textParts.join(''));
  return {
    number: q.number,
    answer: q.answer === '○' ? 'A' : 'B',
    question: `此標誌為：${desc}`,
    options: { A: '○ (正確)', B: '✕ (錯誤)' },
    type: 'tf',
    hasImage: true, // 標記需要圖片
  };
}

// ─── 組裝輸出 ───
function buildOutput(motoQs, carChoiceQs, carTFQs, carSignsTFQs) {
  // 機車題庫
  const motoOut = motoQs.map((q, i) => ({
    id: `moto_${q.number}`,
    subject: '機車法規',
    subject_tag: 'moto_rules',
    subject_name: '機車法規',
    stage_id: 0,
    number: q.number,
    question: q.question,
    options: q.options,
    answer: q.answer,
    type: 'choice',
  }));

  // 汽車題庫 = 法規選擇 + 法規是非 + 標誌是非
  const carOut = [];

  for (const q of carChoiceQs) {
    carOut.push({
      id: `car_choice_${q.number}`,
      subject: '汽車法規',
      subject_tag: 'car_rules',
      subject_name: '汽車法規選擇題',
      stage_id: 0,
      number: q.number,
      question: q.question,
      options: q.options,
      answer: q.answer,
      type: 'choice',
    });
  }

  for (const q of carTFQs) {
    carOut.push({
      id: `car_tf_${q.number}`,
      subject: '汽車法規',
      subject_tag: 'car_rules',
      subject_name: '汽車法規是非題',
      stage_id: 0,
      number: q.number,
      question: q.question,
      options: q.options,
      answer: q.answer,
      type: 'tf',
    });
  }

  // 標誌題需要圖片才有意義，暫時排除
  // for (const q of carSignsTFQs) { ... }

  return { moto: motoOut, car: carOut };
}

// ─── Main ───
async function main() {
  console.log('Parsing driver license question banks...\n');

  const motoQs = await parseMoto();
  const carChoiceQs = await parseCarChoice();
  const carTFQs = await parseCarTF();

  let carSignsTFQs = [];
  if (fs.existsSync(path.join(DIR, 'car_signs_tf.pdf'))) {
    carSignsTFQs = await parseCarSignsTF();
  }

  const { moto, car } = buildOutput(motoQs, carChoiceQs, carTFQs, carSignsTFQs);

  // Validate
  console.log('\n=== Validation ===');
  console.log(`機車: ${moto.length} questions`);
  console.log(`汽車: ${car.length} questions (${carChoiceQs.length} choice + ${carTFQs.length} TF)`);

  // Check for missing options
  let badMoto = 0, badCar = 0;
  for (const q of moto) {
    if (!q.options.A || !q.options.B || !q.options.C) badMoto++;
    if (!q.answer || !['A', 'B', 'C'].includes(q.answer)) badMoto++;
  }
  for (const q of car) {
    if (q.type === 'choice' && (!q.options.A || !q.options.B || !q.options.C)) badCar++;
    if (q.type === 'tf' && (!q.options.A || !q.options.B)) badCar++;
  }
  console.log(`機車 bad questions: ${badMoto}`);
  console.log(`汽車 bad questions: ${badCar}`);

  // Show samples
  console.log('\n=== 機車 samples ===');
  for (const q of moto.slice(0, 3)) {
    console.log(`#${q.number} [${q.answer}] ${q.question}`);
    console.log(`  A: ${q.options.A}`);
    console.log(`  B: ${q.options.B}`);
    console.log(`  C: ${q.options.C}`);
  }

  console.log('\n=== 汽車選擇 samples ===');
  for (const q of car.filter(x => x.type === 'choice').slice(0, 3)) {
    console.log(`#${q.number} [${q.answer}] ${q.question}`);
    console.log(`  A: ${q.options.A}`);
    console.log(`  B: ${q.options.B}`);
    console.log(`  C: ${q.options.C}`);
  }

  console.log('\n=== 汽車是非 samples ===');
  for (const q of car.filter(x => x.type === 'tf' && !x.hasImage).slice(0, 3)) {
    console.log(`#${q.number} [${q.answer}] ${q.question}`);
  }

  // Write output
  const motoPath = path.join(OUT, 'questions-driver-moto.json');
  const carPath = path.join(OUT, 'questions-driver-car.json');
  fs.writeFileSync(motoPath, JSON.stringify(moto, null, 2));
  fs.writeFileSync(carPath, JSON.stringify(car, null, 2));
  console.log(`\nWrote ${motoPath} (${moto.length} questions)`);
  console.log(`Wrote ${carPath} (${car.length} questions)`);
}

main().catch(e => { console.error(e); process.exit(1); });
