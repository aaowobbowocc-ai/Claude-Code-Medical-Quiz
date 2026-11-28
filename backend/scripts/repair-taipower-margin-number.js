#!/usr/bin/env node
/**
 * 清掉台電卷選項尾巴的「左邊欄數字」。
 *
 * 國營聯招的試題解答 PDF 每題的 [答案] 前面還印著一個左邊欄的數字，每題遞增 3：
 *
 *       7 [B] 11. 依政府採購法第65條規定，得標廠商應自行履行勞務契約，下列何者正確？
 *     (A)得轉包、不得分包  (B)不得轉包、得分包
 *     (C)不得轉包、不得分包 (D)得轉包、得分包
 *      10 [B] 12. 公開招標廢標後大幅修改招標文件後再行辦理招標，必須多少家以上廠商投標始得開標？
 *     (A) 1家 (B) 3家 (C)由機關決定 (D)視招標文件之規定
 *      13 [D] 13. 機關辦理採購…
 *
 * 題塊切在下一個「[」的位置，那個數字於是留在**前一題**的尾巴、黏進最後一個選項：
 *     (D) 視招標文件之規定 13
 * 全站 378 個選項中了，而最後一格常常就是正解。
 *
 * ⚠️ 不要用 regex 猜。「尾巴有一個 1~3 位數」在正常選項裡太常見
 * （radiology 102100 #3 的 B 本來就是「其中心結構 Tc 之配位數為 4」），
 * 而且那個數字**不一定**是下一題的題號（遞增 3，常常比本題題號小），
 * 拿題號當判準會漏掉一大半、又擋不住誤判。
 * 所以一律回去抓原卷重解，只有「題庫 = 原卷 + 尾巴那串數字」才動。
 *
 * 判準（全部要過）：
 *   · 題幹正規化後要一字不差（確認重解到的是同一題）
 *   · 砍掉尾巴之後要跟原卷那一格一字不差
 *   · 只動選項，題幹／答案／id 都不碰
 *
 * 解析器那邊已經一起修好了（lib/taipower-parser.js 的切點會往前退過那個數字），
 * 所以之後重爬不會再長出來。
 *
 *   node scripts/repair-taipower-margin-number.js            # 試跑
 *   node scripts/repair-taipower-margin-number.js --apply
 */
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { cachedFetch } = require('./lib/pdf-fetcher');
const { parseTaipowerPdf } = require('./lib/taipower-parser');
const { atomicWriteJson } = require('./lib/atomic-write');

const BK = path.join(__dirname, '..');
const CACHE = path.join(BK, '_tmp', 'taipower-cache');
const INDEX = path.join(BK, '_tmp', '_taipower-index.json');
const REFERER = 'https://www.taipower.com.tw/';
const APPLY = process.argv.includes('--apply');
/** 類科名 -> 題庫檔的 exam id（跟 scrape-taipower.js 的 CATEGORIES 一致） */
const MAP = { 企管: 'state-mgmt', 人資: 'state-hr', 財會: 'state-finance', 資訊: 'state-it' };
const KEYS = ['A', 'B', 'C', 'D'];
/** 題庫是 NFC 正規化過的、原卷沒有，不收 NFKC 的話整卷都對不上（見 project_nfc_normalize） */
const nz = (t) => String(t == null ? '' : t).normalize('NFKC').replace(/\s+/g, '').trim();

(async () => {
  const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  const years = Object.keys(idx).sort();
  const plan = [];
  const problems = {};
  let papers = 0, other = 0;

  for (const cat of Object.keys(MAP)) {
    const exam = MAP[cat];
    const fp = path.join(BK, `questions-${exam}.json`);
    if (!fs.existsSync(fp)) continue;
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    let dirty = false;

    for (const y of years) {
      const e = idx[y] && idx[y][cat];
      if (!e || !e.mcq || !e.mcq.length) continue;
      const code = `taipower-${y}`;
      const bank = arr.filter((q) => q.exam_code === code);
      if (!bank.length) continue;

      let parsed = [];
      try {
        for (const u of e.mcq) {
          const buf = await cachedFetch(u, CACHE, { referer: REFERER, timeout: 60000 });
          parsed = parsed.concat(parseTaipowerPdf((await pdfParse(buf)).text));
        }
      } catch (err) {
        problems[`${exam} ${y} 抓不到或解不出原卷`] = err.message;
        continue;
      }
      papers++;
      const byNum = new Map(parsed.map((p) => [+p.number, p]));

      for (const q of bank) {
        const p = byNum.get(+q.number);
        if (!p) continue;
        if (nz(q.question) !== nz(p.question)) continue;   // 不是同一題就不碰
        for (const k of KEYS) {
          const b = String((q.options || {})[k] || '');
          const n = String(p.options[k] || '');
          if (!b || !n || nz(b) === nz(n)) continue;
          const m = /^([\s\S]*?)\s+\d{1,3}\s*$/.exec(b);
          if (!m || nz(m[1]) !== nz(n)) { other++; continue; }
          plan.push({ exam, code, number: q.number, k, answer: q.answer, before: b, after: m[1].trim() });
          if (APPLY) { q.options[k] = m[1].trim(); dirty = true; }
        }
      }
    }
    if (APPLY && dirty) atomicWriteJson(fp, j);
  }

  /*
   * 國營的共同科目（國文＋英文）進的是 shared-banks/common_state_english.json，
   * 那一份也有 150 個同型的尾巴（見 procedure_shared_bank_sync：主題庫修完
   * 共用題庫要跟著修，不然兩邊會長期不一致）。
   * 共用題庫沒有 exam_code、題號也跟原卷不一定對齊，所以**拿題幹配對**，
   * 題幹本來就是身分驗證那一關，比題號可靠。
   */
  const sbPath = path.join(BK, 'shared-banks', 'common_state_english.json');
  if (fs.existsSync(sbPath)) {
    const sb = JSON.parse(fs.readFileSync(sbPath, 'utf8'));
    const sbArr = Array.isArray(sb) ? sb : sb.questions;
    let sbDirty = false;
    for (const y of years) {
      const e = idx[y] && idx[y]['共同科目'];
      if (!e || !e.mcq || !e.mcq.length) continue;
      const bank = sbArr.filter((q) => String(q.roc_year) === String(y));
      if (!bank.length) continue;
      let parsed = [];
      try {
        for (const u of e.mcq) {
          const buf = await cachedFetch(u, CACHE, { referer: REFERER, timeout: 60000 });
          parsed = parsed.concat(parseTaipowerPdf((await pdfParse(buf)).text));
        }
      } catch (err) {
        problems[`共同科目 ${y} 抓不到或解不出原卷`] = err.message;
        continue;
      }
      papers++;
      const byStem = new Map();
      for (const pq of parsed) byStem.set(nz(pq.question), pq);
      for (const q of bank) {
        const pq = byStem.get(nz(q.question));
        if (!pq) continue;
        for (const k of KEYS) {
          const b = String((q.options || {})[k] || '');
          const n = String(pq.options[k] || '');
          if (!b || !n || nz(b) === nz(n)) continue;
          const m = /^([\s\S]*?)\s+\d{1,3}\s*$/.exec(b);
          if (!m || nz(m[1]) !== nz(n)) { other++; continue; }
          plan.push({ exam: 'common_state_english', code: `共同科目 ${y}`, number: q.number, k, answer: q.answer, before: b, after: m[1].trim() });
          if (APPLY) { q.options[k] = m[1].trim(); sbDirty = true; }
        }
      }
    }
    if (APPLY && sbDirty) atomicWriteJson(sbPath, sb);
  }

  const byExam = {};
  for (const r of plan) byExam[r.exam] = (byExam[r.exam] || 0) + 1;
  const onAnswer = plan.filter((r) => r.k === r.answer).length;
  console.log(`原卷對過 ${papers} 卷｜${APPLY ? '已清掉' : '可清掉'} ${plan.length} 個選項尾巴的邊欄數字`);
  console.log('  依考試:', Object.entries(byExam).map(([k, v]) => `${k}:${v}`).join('  '));
  console.log(`  其中 ${onAnswer} 個就是該題的正解那一格`);
  console.log(`  跟原卷還有其他差異、沒碰的選項：${other} 個`);
  for (const r of plan.slice(0, 12)) {
    console.log(`  ✓ ${r.exam} ${r.code} #${r.number} (${r.k}${r.k === r.answer ? '＝正解' : ''})`);
    console.log(`      前 ${JSON.stringify(r.before.slice(-44))}`);
    console.log(`      後 ${JSON.stringify(r.after.slice(-44))}`);
  }
  if (Object.keys(problems).length) {
    console.log('\n── 原卷抓不到 ──');
    for (const k of Object.keys(problems)) console.log(`   ${k}: ${problems[k]}`);
  }
  fs.writeFileSync(path.join(BK, '_tmp', 'taipower-margin-number.json'), JSON.stringify(plan, null, 1), 'utf8');
  if (!APPLY) console.log('\n(試跑；加 --apply 才寫入)');
})();
