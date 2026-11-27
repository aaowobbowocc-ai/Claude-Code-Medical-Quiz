#!/usr/bin/env node
/**
 * 修「題幹被切碎、碎片塞進選項格」。
 *
 *   railway-admin 103070 公民與英文 #2   答案 D
 *     題幹「某學者研究報告指出：「在地方選舉中，甲候選人民意支持度約達」
 *     A「50%，而乙候選人只有20%，在經過媒體」
 *     B「報導後，使得原來未表態的民眾，選擇表態支持甲…」
 *     C「擇不表態。」本研究報告符合以下那一項概念？」
 *     D「框架理論」                               ← 只有這格是真的選項
 *   真正的四個選項是「框架理論／置入性行銷／總白癡化現象／沉默螺旋理論」，
 *   後三個整個不見了。
 *
 *   customs 108050 英文 #20  答案 A
 *     題幹「What does the word “Int」 ＋ A「erpol” possibly refer to?」
 *     —— 連單字都被從中間切開，而**答案那一格裝的是題幹的尾巴**，
 *      使用者永遠選不到對的。
 *
 * 偵測訊號：**題幹裡一個問號都沒有，而恰好有一格選項是問句**。
 * 中文選擇題的題幹幾乎一定有問號；問號跑到選項裡，就表示題幹在那裡被截斷了。
 * （四格都是問句的那種要排除 —— 那是題目本來就在問「下列哪個句子…」，
 *   例如 audiologist 100140 #12 問哪一句屬於結構式會談。）
 *
 * 修法：用同一張卷上健康的題認出原卷（lib/moex-one-question-rebuild），
 * 再從原卷重解這一題。另加兩道**身分驗證**，確認重解出來的是同一題：
 *   · 題庫題幹的尾段要出現在原卷的題幹裡
 *   · 那格問句的開頭也要出現在原卷的題幹裡
 * 兩條都過，才證明「題庫的題幹 ＋ 那一格」本來就是原卷的同一句話。
 *
 *   node scripts/repair-moex-split-stems.js            # 試跑
 *   node scripts/repair-moex-split-stems.js --apply
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./lib/atomic-write');
const { identifyPaper, rebuildOne, applyRebuild } = require('./lib/moex-one-question-rebuild');
const { skeleton } = require('./lib/moex-normalize');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const ONLY = (process.argv.find((a) => a.startsWith('--exam=')) || '').split('=')[1];
const MIN_HIT = 0.6;

const endsWithQ = (t) => /[？?]\s*$/.test(String(t).trim()) && String(t).trim().length >= 10;
// 有些題的題組情境是**寫在題幹裡**的（沒有 case_context）。原卷重解出來的題幹
// 只有「承上題…」那一句，直接覆寫會把上下文弄不見，題目變成答不了。
// 覆寫前要先把「【題組情境】…」那段搬進 case_context。
const GRP = /^【題組情境】([\s\S]*?)(?=承上題|$)/;

/** 題幹沒問號、恰好一格是問句 → 題幹在那裡被截斷了 */
function splitAt(q) {
  if (/[？?]/.test(String(q.question || ''))) return null;
  const o = q.options || {};
  const hit = Object.keys(o).filter((k) => endsWithQ(o[k]));
  return hit.length === 1 ? hit[0] : null;
}

(async () => {
  const fixed = [], hidden = [], skipped = {};
  const skip = (r) => { skipped[r] = (skipped[r] || 0) + 1; };

  for (const f of fs.readdirSync(BK).filter((x) => /^questions(-.*)?\.json$/.test(x) && !/\.bak/.test(x))) {
    const exam = f === 'questions.json' ? 'doctor1' : f.replace(/^questions-|\.json$/g, '');
    if (ONLY && exam !== ONLY) continue;
    const fp = path.join(BK, f);
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    if (!Array.isArray(arr)) continue;

    const bad = arr.filter((q) => !q.incomplete && splitAt(q));
    if (!bad.length) continue;

    const groups = new Map();
    for (const q of bad) {
      const k = `${q.exam_code}|${q.subject}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(q);
    }

    let dirty = false;
    for (const [k, qs] of groups) {
      const [code, subject] = k.split('|');
      const siblings = arr.filter((q) => String(q.exam_code) === code && q.subject === subject);
      const paper = await identifyPaper({ exam, code, subject, siblings, broken: qs });
      if (!paper) { for (const q of qs) skip(`原卷抓不到或解不出題目（${exam} ${q.exam_code} ${q.subject}）`); continue; }
      if (paper.hit < MIN_HIT) {
        for (const q of qs) skip(`認不出是哪張卷（${exam} ${q.exam_code} ${q.subject}，最高命中率 ${(paper.hit * 100).toFixed(0)}%）`);
        continue;
      }

      for (const q of qs) {
        const key = splitAt(q);
        const tail = skeleton(q.question).slice(-14);
        const head = skeleton(q.options[key]).slice(0, 10);
        const r = rebuildOne(paper, q, (stem) => {
          const sk = skeleton(stem);
          // 身分驗證：題庫題幹的尾段、以及那一格問句的開頭，都要在原卷題幹裡
          if (tail.length >= 8 && !sk.includes(tail)) return '原卷那一題跟題庫的題幹對不起來';
          if (head.length >= 6 && !sk.includes(head)) return '那一格的問句在原卷題幹裡找不到';
          return null;
        });
        if (!r.ok) { hidden.push({ exam, q, key, reason: r.reason }); continue; }
        let ctx = null;
        if (!q.case_context) {
          const m = GRP.exec(String(q.question || ''));
          if (m && m[1].trim().length >= 10) ctx = m[1].trim();
        }
        fixed.push({ exam, q, key, before: String(q.question), beforeOpts: { ...q.options }, r, hit: paper.hit, ctx });
        if (APPLY) { applyRebuild(q, r); if (ctx) q.case_context = ctx; dirty = true; }
      }
    }
    if (APPLY && dirty) atomicWriteJson(fp, j);
  }

  for (const r of fixed) {
    console.log(`${r.exam} ${r.q.exam_code} ${r.q.subject} #${r.q.number}  （認卷命中率 ${(r.hit * 100).toFixed(0)}%，問句原本在 ${r.key}）`);
    console.log(`   舊題幹 ${JSON.stringify(r.before.replace(/\s+/g, ' ').slice(0, 70))}`);
    console.log(`   新題幹 ${JSON.stringify(r.r.stem.replace(/\s+/g, ' ').slice(0, 110))}`);
    for (const x of ['A', 'B', 'C', 'D']) {
      console.log(`   ${x}) ${JSON.stringify(String(r.beforeOpts[x] || '').replace(/\s+/g, ' ').slice(0, 42))} -> ${JSON.stringify(String(r.r.options[x]).replace(/\s+/g, ' ').slice(0, 42))}`);
    }
    console.log(`   答案 ${r.q.answer === r.r.answer ? r.r.answer + '（一樣）' : `${r.q.answer} -> ${r.r.answer}  ⚠️ 答案也改了`}`);
    if (r.ctx) console.log(`   題組情境搬進 case_context: ${JSON.stringify(r.ctx.replace(/\s+/g, ' ').slice(0, 60))}`);
  }
  if (hidden.length) {
    console.log('\n── 原卷對不起來 ──');
    const by = {};
    for (const r of hidden) by[r.reason] = (by[r.reason] || 0) + 1;
    console.log('   ' + JSON.stringify(by, null, 1).replace(/\n/g, '\n   '));
  }

  /*
   * 修不回來的那些還是壞的，而且壞得不一樣：
   * 題幹的碎片落在哪一格，**那一格以後**的選項就整組往後位移了。
   *   碎片在 A → 顯示的 B 其實是官方的 A、C 是 B…，官方的 D 整個不見
   * 所以答案那一格在碎片格**之後**（或就是碎片格）＝ 使用者永遠選不到正解，
   * 要藏起來；在之前就沒被動到，只是題幹被截斷、少一個選項，留著比藏好。
   *
   * 這一輪獨立重掃一次，不是只看上面 hidden —— 連「認不出是哪張卷」而根本
   * 沒進到重建流程的那些也要分級。
   */
  const ORD = 'ABCDEF';
  const hide = [], keep = [];
  for (const f of fs.readdirSync(BK).filter((x) => /^questions(-.*)?\.json$/.test(x) && !/\.bak/.test(x))) {
    const exam = f === 'questions.json' ? 'doctor1' : f.replace(/^questions-|\.json$/g, '');
    if (ONLY && exam !== ONLY) continue;
    const fp = path.join(BK, f);
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    if (!Array.isArray(arr)) continue;
    let dirty = false;
    for (const q of arr) {
      if (q.incomplete) continue;
      const key = splitAt(q);
      if (!key) continue;
      const ai = ORD.indexOf(String(q.answer));
      const fi = ORD.indexOf(key);
      if (ai >= 0 && fi >= 0 && ai < fi) { keep.push({ exam, q, key }); continue; }
      hide.push({ exam, q, key });
      if (APPLY) { q.incomplete = 'stem_split_into_options'; dirty = true; }
    }
    if (APPLY && dirty) atomicWriteJson(fp, j);
  }
  if (hide.length || keep.length) {
    console.log(`\n   答案格在碎片格之後（選不到正解）${APPLY ? '，已藏起來' : '，會藏起來'}：${hide.length} 題`);
    for (const h of hide) console.log(`     ${h.exam} ${h.q.exam_code} ${h.q.subject} #${h.q.number}  ans=${h.q.answer} 碎片在 ${h.key}`);
    console.log(`   答案格在碎片格之前（選項沒位移，只是題幹被截斷），留著：${keep.length} 題`);
    for (const h of keep) console.log(`     ${h.exam} ${h.q.exam_code} ${h.q.subject} #${h.q.number}  ans=${h.q.answer} 碎片在 ${h.key}`);
  }
  console.log(`\n${APPLY ? '已修' : '可修'} ${fixed.length} 題｜${APPLY ? '已藏' : '會藏'} ${hide.length} 題｜留著 ${keep.length} 題`);
  if (Object.keys(skipped).length) console.log('跳過:', JSON.stringify(skipped, null, 1));
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})();
