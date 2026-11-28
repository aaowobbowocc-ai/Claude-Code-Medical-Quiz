#!/usr/bin/env node
/**
 * 驗證並釋放 incomplete='option_order_unverified' 的題。
 *
 * 那個標記是跨科目覆蓋修復時打的：題幹從原卷取回來了，但選項順序無法確認
 * （pdfQuestions 的順序在雙欄版型會整組轉一格）。隱藏是當時的保守作法。
 * 這裡用 pdfText 的閱讀順序驗證：四個選項在「題幹之後的扁平文字」裡
 * 必須依 A→B→C→D 依序出現。對得上就解除隱藏，對不上就維持隱藏。
 *
 *   node scripts/verify-option-order.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { pdfText } = require('./lib/moex-pdf-parse');
const { nz, readPaperOptions } = require('./lib/moex-paper-options');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const flat = s => String(s).replace(/\s+/g, '');

(async () => {
  const mupdf = await import('mupdf');
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f));
  const cache = {};
  let pass = 0, fail = 0, unk = 0;
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions; if (!arr) continue;
    const targets = arr.filter(q => q.incomplete === 'option_order_unverified');
    if (!targets.length) continue;
    const exam = f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '');
    let touched = false;
    for (const q of targets) {
      const key = f + '|' + q.exam_code + '|' + q.subject;
      if (cache[key] === undefined) {
        cache[key] = null;
        try {
          const items = arr.filter(x => x.exam_code === q.exam_code && x.subject === q.subject);
          const p = await resolvePaper({ exam, code: q.exam_code, subject: q.subject, year: String(q.exam_code).slice(0, 3), items });
          if (p) {
            const buf = await fetchSheet('Q', q.exam_code, p.c, p.s);
            cache[key] = { ft: flat(await pdfText(buf)), geo: readPaperOptions(mupdf, buf) };
          }
        } catch (e) { cache[key] = null; }
      }
      const pk = cache[key];
      const tag = [f, q.exam_code, q.subject, '#' + q.number];
      const opts = ['A', 'B', 'C', 'D'].map(k => flat((q.options || {})[k] || ''));
      if (!pk || opts.some(o => !o)) { unk++; continue; }

      let verdict = null;
      /*
       * 路線一（主判準）：版面幾何逐格比。
       * 雙欄版型的閱讀順序會把四個選項打散，扁平比對找不到題幹或排不出順序，
       * 原本一律算「無法驗證」而永遠隱藏（7 筆卡在這裡）。
       * 幾何那一支直接給「原卷第 N 題的 A/B/C/D 各是哪一行」，逐格比前綴就好。
       */
      if (pk.geo && pk.geo.opts) {
        const po = pk.geo.opts[+q.number];
        if (po && ['A', 'B', 'C', 'D'].every(k => po[k] && po[k].raw)) {
          /*
           * 短選項要全等比。前缀比對定了最少 6 字，而「①」「①④」這種圈號組合選項
           * 長度只有 1~2 字，永遠過不了門檻 —— 整題會退回扁平那條路被誤報成
           * 「順序不符」（聲語 102030 #36/#52 實測）。
           */
          /*
           * 比對時要容忍「下標已經被修回來」：原卷的文字層是 cm HO，
           * 題庫被 repair-flung-subscript 修成 cm H2O，直接比對會把正確的題
           * 報成「順序不符」（聲語 101110 #2 實測）。兩邊都把字母之間的
           * 下標數字抽掉再比。
           */
          const sub = (t) => String(t).replace(/(?<=[A-Za-z])[23](?=[A-Za-z])/g, '');
          const same = (a, b) => {
            const x = sub(nz(a)), y = sub(nz(b));
            if (!x || !y) return false;
            if (x.length < 6 || y.length < 6) return x === y;
            const n = Math.min(14, x.length, y.length);
            return x.startsWith(y.slice(0, n)) || y.startsWith(x.slice(0, n));
          };
          const allSame = ['A', 'B', 'C', 'D'].every(k => same(po[k].raw, (q.options || {})[k]));
          // 題幹也要對得上，不然是「這一格裝了別卷的題」，不是順序問題
          const ps = (pk.geo.stems || {})[+q.number] || '';
          const body = String(q.question || '').split('\n\n').pop();
          const stemOk = nz(ps).includes(nz(body).slice(0, 12)) && nz(body).length >= 12;
          if (allSame && stemOk) verdict = 'pass';
          else if (stemOk) verdict = 'fail';
        }
      }

      // 路線二（幾何沒結論才走）：扁平閱讀順序 —— 四個選項要依 A→B→C→D 依序出現在題幹後面
      const ft = pk.ft, fs2 = flat(q.question);
      let si = -1;
      for (const pr of [fs2.slice(0, 20), fs2.slice(0, 14), fs2.slice(4, 20), fs2.slice(0, 10)]) {
        if (pr.length < 8) continue; si = ft.indexOf(pr); if (si >= 0) break;
      }
      if (verdict === null && si >= 0) {
        const win = ft.slice(si + fs2.length - 4, si + fs2.length + opts.reduce((n, o) => n + o.length, 0) + 60);
        let end = -1, ok = true;
        for (const o of opts) { const i = win.indexOf(o, Math.max(0, end)); if (i < 0 || i < end) { ok = false; break; } end = i + o.length; }
        verdict = ok ? 'pass' : 'fail';
      }

      if (verdict === 'pass') { if (APPLY) { delete q.incomplete; touched = true; } pass++; console.log('  ✓ 全部對得上原卷', ...tag); }
      else if (verdict === 'fail') { fail++; console.log('  ✗ 順序不符', ...tag); }
      else { unk++; console.log('  ⊛ 驗不出來', ...tag); }
    }
    if (APPLY && touched) fs.writeFileSync(path.join(BK, f), JSON.stringify(j, null, 2) + '\n', 'utf8');
    console.log(f, '→ 待驗', targets.length);
  }
  console.log(`
順序正確 ${pass}（${APPLY ? '已解除隱藏' : '可解除隱藏'}）｜順序不符 ${fail}｜無法驗證 ${unk}`);
})().catch(e => { console.error(e.stack); process.exit(1); });
