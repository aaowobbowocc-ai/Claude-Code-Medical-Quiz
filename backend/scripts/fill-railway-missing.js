#!/usr/bin/env node
/**
 * 補鐵路特考（台鐵招考）佐級題庫的缺題。
 *
 * 缺題盤點（2026-11-28）：兩個考試合計 170 題，分兩種壞法 ——
 *   · 專業科目／國文：零星單題。版面解析失手（題號自己佔一行、選項擠在同一列
 *     字距小於門檻…），題幹和選項都還在卷上，只有拿題號去數才看得到。
 *   · 公民與英文：年年固定缺卷尾一整段（第41-50題）。那是英文的克漏字與閱讀
 *     測驗，題幹是上面那一整篇文章，題目本身只有四個選項。這種**不能**硬補：
 *     補進去會變成沒有題幹的題（見 [[project_ceec_cloze_sections]]）。
 *
 * 所以這支只補「原卷解得出完整題幹＋完整選項」而且答案卷對得上的題。
 * 四道檢查全過才寫入：
 *   · 題幹不是空的、也不是只有幾個字的碎片
 *   · 選項四格（或複選五格）都有字
 *   · 答案卷給的字母有對應的選項
 *   · 同一張卷上既有的題要對得上題庫（確認抓到的是同一卷）
 *
 *   node scripts/fill-railway-missing.js            # 試跑
 *   node scripts/fill-railway-missing.js --apply
 */
const fs = require('fs');
const path = require('path');
const { fetchSheet } = require('./lib/moex-paper-resolve');
const { parseAnswerSheet } = require('./lib/moex-answer-sheet');
const { skeleton, sameName } = require('./lib/moex-normalize');
const { atomicWriteJson } = require('./lib/atomic-write');
const S = require('./scrape-railway.js');

const BK = path.join(__dirname, '..');
const MAP = JSON.parse(fs.readFileSync(path.join(__dirname, '_railway-map.json'), 'utf8'));
const APPLY = process.argv.includes('--apply');
const KEYS4 = ['A', 'B', 'C', 'D'];

/** 這一科這一年應該有幾題 */
function expected(subject, roc) {
  if (/國文/.test(subject)) return +roc <= 102 ? 50 : 45;
  return 50;
}

/** 國文 103 年起第36-45題是複選題（五個選項） */
const isMultiNum = (subject, roc, n) => /國文/.test(subject) && +roc >= 103 && n >= 36 && n <= 45;

(async () => {
  const report = [];
  let added = 0, rejected = 0;

  for (const examKey of ['admin', 'transport']) {
    const def = S.EXAMS[examKey];
    const file = path.join(BK, def.file);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = data.questions;
    let nextId = arr.length ? Math.max(...arr.map(q => +q.id || 0)) + 1 : 1;
    const newOnes = [];

    for (const roc of Object.keys(MAP).sort()) {
      const ym = MAP[roc];
      const cls = ym[def.cKey];
      if (!cls) continue;

      for (const [code, rawName] of Object.entries(cls.subjects)) {
        // 題庫裡的科目名是去掉括號的短名
        // 科目名要放寬比對：同一科在不同年的卷上叫「運輸學大意」或「鐵路運輸學大意」，
        // sameName 的前綴規則對不上（兩邊都不是另一邊的開頭），整科會被安靜跳過。
        const bare = (t) => String(t).replace(/^鐵路/, '');
        const siblings = arr.filter(q => q.roc_year === roc
          && (sameName(q.subject, rawName) || sameName(bare(q.subject), bare(rawName))));
        if (!siblings.length) { report.push([examKey, roc, rawName, '題庫裡沒有這一科，跳過']); continue; }
        const subject = siblings[0].subject;
        const have = new Set(siblings.map(q => +q.number));
        const exp = expected(subject, roc);
        const missing = [];
        for (let n = 1; n <= exp; n++) if (!have.has(n)) missing.push(n);
        if (!missing.length) continue;

        const qBuf = await fetchSheet('Q', ym.sessionCode, cls.c, code);
        if (!qBuf) { report.push([examKey, roc, subject, `缺 ${missing.length} 題，但抓不到原卷`]); continue; }
        const items = await S.extractPositionedText(qBuf);
        const lines = S.buildLogicalLines(items);
        const maxOpts = /國文/.test(subject) && +roc >= 103 ? 5 : 4;
        const parsed = S.parseQuestions(lines, maxOpts);
        const byNum = new Map(parsed.map(q => [q.number, q]));

        // 身分驗證：這張卷既有的題要對得上題庫，不然就是抓錯卷
        let hit = 0, seen = 0;
        for (const q of siblings) {
          const p = byNum.get(+q.number);
          if (!p) continue;
          seen++;
          if (skeleton(p.question) === skeleton(q.question)) hit++;
        }
        const rate = seen ? hit / seen : 0;
        if (rate < 0.6) {
          report.push([examKey, roc, subject, `缺 ${missing.length} 題，但認不出是同一張卷（命中率 ${(rate * 100).toFixed(0)}%）`]);
          continue;
        }

        const sBuf = await fetchSheet('S', ym.sessionCode, cls.c, code);
        const ans = sBuf ? await parseAnswerSheet(sBuf) : null;

        for (const n of missing) {
          const p = byNum.get(n);
          const bad = [];
          if (!p) bad.push('原卷也解不出來');
          else {
            const stem = String(p.question || '').trim();
            // 克漏字那種題幹是上面那篇文章，解出來只有一點碎片 -> 不能補
            if (stem.replace(/\s/g, '').length < 8) bad.push(`題幹只有 ${stem.replace(/\s/g, '').length} 個字（克漏字／閱讀測驗的題幹在文章裡）`);
            const keys = isMultiNum(subject, roc, n) ? [...KEYS4, 'E'] : KEYS4;
            if (!keys.every(k => String(p.options?.[k] || '').trim())) bad.push(`選項不滿 ${keys.length} 格`);
            const a = String(ans?.[n] || '').replace(/[^A-E]/g, '');
            if (!a) bad.push('答案卷查不到答案');
            else if (!a.split('').every(k => p.options?.[k])) bad.push(`答案 ${a} 指到不存在的選項`);
            else if (!isMultiNum(subject, roc, n) && a.length > 1) bad.push(`單選題卻拿到多字母答案 ${a}`);
          }
          if (bad.length) {
            rejected++;
            report.push([examKey, roc, subject, `#${n} 不補：${bad.join('；')}`]);
            continue;
          }
          const a = String(ans[n]).replace(/[^A-E]/g, '');
          const multi = isMultiNum(subject, roc, n) && a.length > 1;
          const tpl = siblings[0];
          newOnes.push({
            id: nextId++,
            roc_year: roc,
            session: tpl.session,
            exam_code: tpl.exam_code,
            subject,
            subject_tag: tpl.subject_tag,
            subject_name: tpl.subject_name,
            stage_id: tpl.stage_id ?? 0,
            number: n,
            question: p.question,
            options: p.options,
            answer: multi ? a.split('').join(',') : a,
            ...(multi ? { is_multi: true } : {}),
            explanation: '',
          });
          added++;
          report.push([examKey, roc, subject, `#${n} ✓ 答案 ${a}  ${JSON.stringify(String(p.question).replace(/\s+/g, ' ').slice(0, 46))}`]);
        }
      }
    }

    if (newOnes.length) {
      console.log(`\n${def.file}: ${arr.length} → ${arr.length + newOnes.length} 題（新增 ${newOnes.length}）`);
      if (APPLY) {
        // 照原本的順序接在後面，不要重排 —— 重排會生出沒人看得懂的 diff
        arr.push(...newOnes);
        data.total = arr.length;
        atomicWriteJson(file, data);
      }
    }
  }

  for (const r of report) console.log('  ' + r.join(' | '));
  console.log(`\n${APPLY ? '已補' : '可補'} ${added} 題｜不補 ${rejected} 題`);
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})();
