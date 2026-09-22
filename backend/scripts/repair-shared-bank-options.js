#!/usr/bin/env node
/**
 * 修共用題庫（shared-banks/）裡「選項不完整或重複」的題。
 *
 * 共用題庫是當年從主題庫或原卷複製過去的，之後主題庫修過很多輪、共用那一份沒跟上，
 * 於是留下一堆四個選項只剩兩三個、或整組選項黏成一格的題（實測 78 題）。
 * 2026-09-22 把答案同步回主題庫之後，其中 3 題的答案字母甚至指到不存在的選項。
 *
 * 兩條修復路徑：
 *   1. source_exam_code 對得到主題庫（police / customs / police4）→ 直接取主題庫那一份
 *      （主題庫的選項與答案已經修過很多輪，見 procedure_answer_audit_sitewide）
 *   2. 其餘（普考／地特等）→ 回考選部原卷解析
 *
 * 配對一律用「年份 + 題號 + 題幹前綴」三者，光比題幹會撞名。
 *
 *   node scripts/repair-shared-bank-options.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const { paperQuestions } = require('./fill-civil-gaps');
const { sheetMap } = require('./lib/moex-answer-geo');
const { skeleton } = require('./lib/moex-normalize');
const { atomicWriteJson } = require('./lib/atomic-write');
const { buildPapers } = require('./audit-shared-bank-answers');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const PUA = /[-]/;
const SOURCES = { police: 'questions-police.json', customs: 'questions-customs.json', police4: 'questions-police4.json' };

const optsOf = o => ['A', 'B', 'C', 'D'].map(k => String(o[k] || '').trim());
// 辨異要用 skeleton：主題庫裡有些題的兩個選項只差一個全形／半形逗號
// （「不僅及於」vs「不僅及於」中間的，與,），用原字串比會判成不同，
// 結果把一組實際重複的選項複製到共用題庫。那種題寧可不修，留著等另外處理。
const usable = a => a.length === 4 && a.every(t => t)
  && new Set(a.map(t => skeleton(t))).size === 4 && !a.some(t => PUA.test(t));
const key = (year, n, stem) => `${year}|${n}|${skeleton(stem).slice(0, 24)}`;

(async () => {
  // 主題庫索引
  const mainIdx = {};
  for (const [src, f] of Object.entries(SOURCES)) {
    const p = path.join(BK, f);
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    const idx = new Map();
    for (const q of arr) idx.set(key(String(q.exam_code || '').slice(0, 3), q.number, q.question), q);
    mainIdx[src] = idx;
  }

  // 壞掉的題，依 bank 分組
  const banks = {}, broken = [];
  for (const f of fs.readdirSync(path.join(BK, 'shared-banks')).filter(x => /\.json$/.test(x))) {
    const p = path.join(BK, 'shared-banks', f);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = Array.isArray(raw) ? raw : raw.questions;
    if (!arr) continue;
    banks[p] = { raw, arr, bank: f.replace(/\.json$/, ''), dirty: false };
    for (const q of arr) if (!usable(optsOf(q.options || {}))) broken.push({ p, q });
  }
  console.log(`選項壞掉的共用題：${broken.length} 題`);

  const fixed = [], skip = [];

  // --- 路徑 1：主題庫 ---
  const rest = [];
  for (const b of broken) {
    const idx = mainIdx[b.q.source_exam_code];
    const m = idx && idx.get(key(b.q.roc_year, b.q.number, b.q.question));
    if (!m) { rest.push(b); continue; }
    const o = optsOf(m.options || {});
    if (!usable(o)) { skip.push({ id: b.q.id, why: '主題庫那一份也壞掉' }); continue; }
    fixed.push({ id: b.q.id, bank: banks[b.p].bank, n: b.q.number, via: '主題庫', ans: `${b.q.answer}→${m.answer}`, neu: o.map(t => t.slice(0, 16)) });
    if (APPLY) {
      b.q.options = { A: o[0], B: o[1], C: o[2], D: o[3] };
      b.q.answer = m.answer;
      if (skeleton(m.question).startsWith(skeleton(b.q.question)) && m.question.length > b.q.question.length) b.q.question = m.question;
      banks[b.p].dirty = true;
    }
  }

  // --- 路徑 2：回原卷 ---
  const papers = buildPapers();
  const byPaper = {};
  for (const b of rest) {
    const bank = banks[b.p].bank;
    const cand = papers.filter(x => x.bank === bank && String(x.year) === String(b.q.roc_year)
      && (!x.sourceCode || x.sourceCode === b.q.source_exam_code));
    if (!cand.length) { skip.push({ id: b.q.id, why: '沒有這張卷的 code/c/s' }); continue; }
    const p0 = cand[0];
    const k = `${p0.code}|${p0.c}|${p0.s}`;
    (byPaper[k] = byPaper[k] || { p: p0, items: [] }).items.push(b);
  }
  let errs = 0;
  for (const k of Object.keys(byPaper)) {
    const { p: p0, items } = byPaper[k];
    let src, sheet;
    try {
      src = await paperQuestions(p0.code, p0.c, p0.s);
      sheet = (await sheetMap(p0.code, p0.c, p0.s, 50)).map;
    } catch (e) { errs++; items.forEach(b => skip.push({ id: b.q.id, why: '原卷處理失敗: ' + e.message.slice(0, 40) })); continue; }
    for (const b of items) {
      const s = src.get(+b.q.number);
      if (!s) { skip.push({ id: b.q.id, why: '原卷解析不到該題號' }); continue; }
      const a = skeleton(b.q.question), sb = skeleton(s.stem || '');
      if (!a || !sb || !(sb.startsWith(a.slice(0, 18)) || a.startsWith(sb.slice(0, 18)))) { skip.push({ id: b.q.id, why: '題幹與原卷對不上' }); continue; }
      const o = optsOf(s.options || {});
      if (!usable(o)) { skip.push({ id: b.q.id, why: '原卷選項也不完整' }); continue; }
      const official = sheet.get(+b.q.number);
      if (!official) { skip.push({ id: b.q.id, why: '取不到官方答案' }); continue; }
      fixed.push({ id: b.q.id, bank: banks[b.p].bank, n: b.q.number, via: '原卷', ans: `${b.q.answer}→${official}`, neu: o.map(t => t.slice(0, 16)) });
      if (APPLY) {
        b.q.options = { A: o[0], B: o[1], C: o[2], D: o[3] };
        b.q.answer = official;
        const tail = sb.slice(a.length);
        // 同上：補回的那段不能是選項文字
        if (sb.startsWith(a) && sb.length > a.length && !tail.includes(skeleton(o[0]))) b.q.question = String(s.stem).trim();
        banks[b.p].dirty = true;
      }
    }
  }

  console.log(`\n可修 ${fixed.length} 題（主題庫 ${fixed.filter(f => f.via === '主題庫').length}、原卷 ${fixed.filter(f => f.via === '原卷').length}）；未處理 ${skip.length} 題；原卷處理失敗 ${errs} 卷`);
  const byWhy = {}; skip.forEach(r => (byWhy[r.why] = (byWhy[r.why] || 0) + 1));
  Object.entries(byWhy).sort((a, b) => b[1] - a[1]).forEach(([w, n]) => console.log(`  ${n} 題 — ${w}`));
  fs.writeFileSync(path.join(BK, '_tmp', 'shared-option-repair.json'), JSON.stringify({ fixed, skip }, null, 1), 'utf8');
  fixed.slice(0, 12).forEach(r => console.log(`  ✓ ${r.bank} #${r.n} [${r.via}] 答 ${r.ans}\n      ${r.neu.join(' / ')}`));
  if (APPLY) {
    let n = 0;
    for (const p of Object.keys(banks)) if (banks[p].dirty) { atomicWriteJson(p, banks[p].raw); n++; }
    console.log(`\n已寫回 ${n} 個共用題庫`);
  } else console.log('\n(試跑；加 --apply 才寫入)');
})().catch(e => { console.error(e.stack); process.exit(1); });
