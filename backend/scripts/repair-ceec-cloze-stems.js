#!/usr/bin/env node
/**
 * 修克漏字「每一組最後一題」—— 題幹存成了選項列。
 *
 * 克漏字的空格在文章裡，卷上沒有題幹，所以解析器要自己補作答指示
 * （「請依文意選出第 N 格最適當的一個選項」）＋把文章掛成 case_context。
 * 一組的最後一題踩到邊界：卷上它的選項列後面緊接著節次標題或下一段文章，
 * 於是題幹欄位收進了自己的選項列，case_context 空的，而**最後一個選項被截斷**：
 *
 *   gsat_110 英文 #20  題幹「(A) installing (B) installed (C) to install (D) having installed 第21至25題」
 *                      選項 D 只存到「having」
 *   gsat_115 英文 #20  選項整組是**篇章結構**那一節的句子，跟這題無關
 *   gsat_100 英文 #30  選項整組是**文意選填**的字庫
 *
 * 做法：題幹裡那串選項列是卷上原文，拿它回原卷定位（lib/ceec-paper-segments），
 * 確認它在卷上只出現一處、且排在這個題號底下（克漏字的空格號碼會印在文章裡，
 * 所以題號流在這裡仍有解析度），再確認這題落在前一題文章宣告的題組範圍內，
 * 才用卷上那組選項覆蓋題庫，並把題幹與文章
 * 照同一組的前一題補齊。答案不動 —— 答案是用題號查答案卷的，題號沒壞。
 *
 * ⚠️ 只處理「同組前一題是健康的」那些。gsat_100/101/102 的綜合測驗整節都壞掉
 *    （卷上沒有「第16至20題為題組」那行宣告，文章從來沒被抓到），沒有健康的
 *    前一題可抄，要另外處理。
 *
 *   node scripts/repair-ceec-cloze-stems.js            # 試跑
 *   node scripts/repair-ceec-cloze-stems.js --apply
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./lib/atomic-write');
const { paperSegments, findOptionRuns, numberBefore } = require('./lib/ceec-paper-segments');
const { cleanTail } = require('./lib/ceec-tail');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const STEM_AS_OPTS = /^\s*[（(]\s*[A-J]\s*[)）]/;
const MARK = /[（(]\s*([A-J])\s*[)）]/g;
const LETTERS = 'ABCDEFGHIJ';
const cmp = s => String(s).normalize('NFKC').replace(/\s+/g, '').toLowerCase();

/** 從「(A) x (B) y (C) z (D) w …」這種題幹切出選項。遇到不連續的字母就停。 */
function optsFromStem(stem) {
  const hits = [...String(stem).matchAll(MARK)];
  const out = {};
  let n = 0;
  for (let i = 0; i < hits.length; i++) {
    if (hits[i][1] !== LETTERS[n]) break;
    const from = hits[i].index + hits[i][0].length;
    const to = (i + 1 < hits.length && hits[i + 1][1] === LETTERS[n + 1]) ? hits[i + 1].index : String(stem).length;
    const t = cleanTail(String(stem).slice(from, to)).trim();
    if (!t) break;
    out[LETTERS[n]] = t;
    n++;
  }
  return n >= 4 ? out : null;
}

(async () => {
  const fixed = [], skipped = {};
  const skip = r => { skipped[r] = (skipped[r] || 0) + 1; };

  for (const f of ['questions-gsat.json', 'questions-ast.json']) {
    const fp = path.join(BK, f);
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    let dirty = false;

    for (const q of arr) {
      if (q.incomplete) continue;
      if (!STEM_AS_OPTS.test(String(q.question || ''))) continue;
      const prev = arr.find(x => x.exam_code === q.exam_code && x.subject_tag === q.subject_tag
        && +x.number === +q.number - 1);
      if (!prev || !/依文意/.test(String(prev.question || '')) || !prev.case_context) { skip('同組前一題也壞掉，不處理'); continue; }

      const parsed = optsFromStem(q.question);
      if (!parsed) { skip('題幹裡切不出四個選項'); continue; }

      // 回原卷確認這串選項確實排在這個題號底下
      const tag = `${q.exam_code}_${q.subject_tag}`;
      const S = await paperSegments(tag);
      if (!S) { skip('本機沒有這份原卷'); continue; }
      const keys = Object.keys(parsed);
      const runs = findOptionRuns(S.segs, parsed, keys);
      if (runs.length !== 1) { skip('這串選項在卷上定位不到（或有多處）'); continue; }
      const real = numberBefore(S.nums, runs[0]);
      if (real !== null && real !== +q.number) { skip(`交叉驗證：卷上這串選項是 #${real} 的`); continue; }

      // 卷上那組選項才是權威（題庫的最後一格常被截斷）
      const next = {};
      for (let n = 0; n < keys.length; n++) next[keys[n]] = cleanTail(S.segs[runs[0] + n].text).trim();
      if (Object.values(next).some(v => !v)) { skip('卷上切出來有空的選項'); continue; }
      if (new Set(Object.values(next).map(cmp)).size !== keys.length) { skip('卷上切出來有重複選項'); continue; }
      if (!next[q.answer]) { skip('答案那個字母在新選項裡沒有，不敢動'); continue; }

      // 前一題的 case_context 寫著「（第 X～Y 題共用下文…」，
      // 這題要落在那個範圍內，文章才拄得過來
      const gr = /第\s*(\d+)\s*[～~-]\s*(\d+)\s*題/.exec(String(prev.case_context));
      if (!gr) { skip('前一題的文章没寫題組範圍'); continue; }
      if (+q.number < +gr[1] || +q.number > +gr[2]) { skip(`這題不在前一題的題組範圍內（${gr[1]}～${gr[2]}）`); continue; }

      const stem = String(prev.question).replace(/第\s*\d+\s*格/g, `第 ${q.number} 格`);
      const ctx = String(prev.case_context).replace(/本題問第\s*\d+\s*格/g, `本題問第 ${q.number} 格`);
      const changed = Object.keys(next).filter(k => cmp(next[k]) !== cmp((q.options || {})[k] || ''));

      fixed.push({ q, before: q.options, next, changed, stem });
      if (APPLY) { q.options = next; q.question = stem; q.case_context = ctx; dirty = true; }
    }
    if (APPLY && dirty) atomicWriteJson(fp, j);
  }

  for (const r of fixed) {
    console.log(`${r.q.exam_code} ${r.q.subject} #${r.q.number}  ans=${r.q.answer}  選項改 ${r.changed.length} 格`);
    for (const k of r.changed) console.log(`   ${k})  ${JSON.stringify(String((r.before || {})[k] || '').slice(0, 60))} → ${JSON.stringify(r.next[k].slice(0, 60))}`);
    console.log(`   題幹 → ${r.stem}`);
  }
  console.log(`\n${APPLY ? '已修' : '可修'} ${fixed.length} 題`);
  if (Object.keys(skipped).length) console.log('跳過:', JSON.stringify(skipped, null, 1));
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})();
