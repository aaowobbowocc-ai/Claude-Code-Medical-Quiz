#!/usr/bin/env node
/**
 * 補學測／分科**整題沒進題庫**的單選題。
 *
 * 兩個互相餵養的 bug 讓一整類題消失（兩個都已在 scrape-ceec.js 修掉）：
 *   1. 選項只抓到 (D) —— 五選一的題第五格沒解析出來
 *   2. 答案只認 A~D   —— 於是**答案是 E 的題整題被丟掉**
 * 丟得無聲無息：缺題盤點用的是題庫自己的題號，看不出少了一整類。
 * 用官方答案卷算，學測 123 題、分科 12 題。
 *
 * 這支**只新增、不改既有題**：同一卷同一題號已經在題庫裡的，一律跳過。
 * 題庫裡那些題被修過很多輪（NFC、下標、PUA、選項對原卷…），重解會蓋掉。
 *
 * PDF 走 _tmp/ceec-pdf（試卷）與 _tmp/ceec-ans（答案）的本機快取，不連網。
 * 組題用 scrape-ceec.js 匯出的 buildQuestions，確保欄位與爬蟲一致。
 *
 *   node scripts/fill-ceec-missing.js            # 試跑
 *   node scripts/fill-ceec-missing.js --apply
 *   node scripts/fill-ceec-missing.js --exam=gsat --year=105
 */
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { atomicWriteJson } = require('./lib/atomic-write');
const { REGISTRY, parseQuestions, parseAnswers, buildQuestions } = require('./scrape-ceec');
const { paperSegments, findOptionRuns, numberBefore } = require('./lib/ceec-paper-segments');
const { cleanTail } = require('./lib/ceec-tail');

const BK = path.join(__dirname, '..');
const QDIR = path.join(BK, '_tmp', 'ceec-pdf');
const ADIR = path.join(BK, '_tmp', 'ceec-ans');
const APPLY = process.argv.includes('--apply');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const ONLY_EXAM = arg('exam'), ONLY_YEAR = arg('year');

const OUT = { gsat: 'questions-gsat.json', ast: 'questions-ast.json' };

(async () => {
  const added = [], skipped = {};
  const skip = r => { skipped[r] = (skipped[r] || 0) + 1; };

  for (const [examId, examDef] of Object.entries(REGISTRY)) {
    if (ONLY_EXAM && examId !== ONLY_EXAM) continue;
    const fp = path.join(BK, OUT[examId] || examDef.outputFile);
    if (!fs.existsSync(fp)) { console.log(`跳過 ${examId}：找不到 ${fp}`); continue; }
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    let dirty = false;

    for (const [year, yearUrls] of Object.entries(examDef.years)) {
      if (ONLY_YEAR && year !== ONLY_YEAR) continue;
      for (const subjectDef of examDef.subjects) {
        const tag = subjectDef.tag;
        if (!yearUrls[tag]) continue;
        const qp = path.join(QDIR, `${examId}_${year}_${tag}.pdf`);
        const ap = path.join(ADIR, `${examId}_${year}_${tag}.pdf`);
        if (!fs.existsSync(qp) || !fs.existsSync(ap)) { skip('本機沒有試卷或答案 PDF'); continue; }

        const examCode = `${examId}_${year}`;
        // ⚠️ 用 subject_tag 不要用 subject 名稱比對：同一科在不同年度的中文名
        // 不一定一樣（114 學測國文的卷名是「國語文綜合能力測驗」），用名稱比
        // 會以為題庫沒有這一題而重複寫入。id 那層是第二道保險。
        const have = new Set(arr.filter(q => q.exam_code === examCode && q.subject_tag === tag)
          .map(q => String(q.number)));
        const haveIds = new Set(arr.map(q => String(q.id)));

        const parsedQs = parseQuestions((await pdfParse(fs.readFileSync(qp))).text);
        const ansMap = parseAnswers((await pdfParse(fs.readFileSync(ap))).text);
        const built = buildQuestions({
          examId, year, subjectTag: tag, subjectName: subjectDef.name, parsedQs, answerMap: ansMap,
        });

        // 同一卷解出兩個同題號 = 其中一個是誤判（公式裡的「1.」被當成題號，
        // 見 project_ceec_coverage）。分不出哪個是真的，兩個都不收。
        const dupNum = new Set();
        const seen = new Set();
        for (const q of built) {
          if (seen.has(String(q.number))) dupNum.add(String(q.number));
          seen.add(String(q.number));
        }

        for (const q of built) {
          if (dupNum.has(String(q.number))) { skip('同一卷解出兩個同題號，分不出哪個是真的'); continue; }
          if (have.has(String(q.number))) { skip('題庫已經有這一題'); continue; }
          if (haveIds.has(String(q.id))) { skip('id 已存在'); continue; }
          // 題幹太短多半是題號解析錯（見 project_ceec_coverage），寧可不收
          if (String(q.question).replace(/\s+/g, '').length < 8 && !q.case_context) {
            skip('題幹太短，可能是題號解析錯'); continue;
          }
          if (!q.options.A || !q.options.B || !q.options.C || !q.options.D) { skip('選項不齊'); continue; }
          const vals = Object.values(q.options).map(v => String(v).replace(/\s+/g, ''));
          if (new Set(vals).size < vals.length) { skip('解出來的選項有重複'); continue; }
          if (!q.options[q.answer]) { skip('答案指向不存在的選項'); continue; }

          // 最後一格常把後面的圖說吃進來（gsat_101 自然 #4 的 E 尾巴是
          //「圖1圖2 甲 乙 丙 丁 戊 己 庚 辛 溫度(°C) 圖4 …」，而 E 還是正確答案）。
          // 用與 repair-ceec-fifth-option.js 同一份殘渣清單剪尾巴，剪得掉就不用
          // 把整題丟掉。只認明確標記，認不出來的原樣留著。
          for (const k of Object.keys(q.options)) {
            const cut = cleanTail(q.options[k]);
            if (cut && cut.length >= 2) q.options[k] = cut;
          }

          // 科學記號被 PDF 打散：1.2×10¹² 變成「12 1.2 10」（指數跑到最前面）。
          // 兩格以上長這樣就是整題的數學式都碎了，解析器救不了
          //（見 procedure_unextractable_text），收進來只是多一題亂碼。
          const shattered = Object.values(q.options)
            .filter(v => /^\d+\s+[\d.]/.test(String(v).trim())).length;
          if (shattered >= 2) { skip('選項是被打散的科學記號'); continue; }

          // 某一格比其他格長一截 = 它把後面的圖說／下一題吃進來了
          //（gsat_103 自然 #5 的 E 尾巴是「平均水面 甲 乙 丙 丁 … 圖1」）。
          const lens = Object.values(q.options).map(v => String(v).replace(/\s+/g, '').length).sort((a, b) => b - a);
          if (lens[0] > 30 && lens[0] > lens[1] * 3) { skip('有一格選項長得不合理，吃到圖說或別題'); continue; }

          // ── 交叉驗證題號 ──
          // 這題的答案是用**題號**去答案卷查的，題號一錯掛上去的就是別題的答案。
          // 上面那套解析是 pdf-parse（整頁攤平）；這裡改用 mupdf 逐行＋片段流
          // 重走一次，要求兩套解析對同一題給出同一個題號才收。
          const S = await paperSegments(`${examId}_${year}_${tag}`);
          if (!S) { skip('沒有原卷可交叉驗證'); continue; }
          const keys = ['A', 'B', 'C', 'D'].concat(q.options.E ? ['E'] : []);
          const runs = findOptionRuns(S.segs, q.options, keys);
          if (!runs.length) { skip('交叉驗證：卷上對不到這題的選項'); continue; }
          if (runs.length > 1) { skip('交叉驗證：卷上有多處選項一模一樣，確認不了是第幾題'); continue; }
          const realNum = numberBefore(S.nums, runs[0]);
          if (realNum !== +q.number) { skip(`交叉驗證：題號對不上（卷上是 #${realNum}）`); continue; }

          added.push(q);
          if (APPLY) { arr.push(q); dirty = true; haveIds.add(String(q.id)); have.add(String(q.number)); }
        }
      }
    }
    if (APPLY && dirty) {
      arr.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      atomicWriteJson(fp, j);
    }
  }

  const byPaper = {};
  for (const q of added) {
    const k = `${q.exam_code} ${q.subject}`;
    (byPaper[k] = byPaper[k] || []).push(`${q.number}(${q.answer})`);
  }
  for (const [k, v] of Object.entries(byPaper).sort()) {
    console.log(`${k.padEnd(18)} +${String(v.length).padStart(3)}  ${v.join(' ')}`);
  }
  const DUMP = arg('dump');
  if (DUMP) { fs.writeFileSync(DUMP, JSON.stringify(added, null, 2)); console.log(`候選已輸出 -> ${DUMP}`); }
  console.log(`\n${APPLY ? '已新增' : '可新增'} ${added.length} 題`);
  console.log(`其中答案是 E 的 ${added.filter(q => q.answer === 'E').length} 題`);
  if (Object.keys(skipped).length) console.log('跳過:', JSON.stringify(skipped, null, 1));
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})();
