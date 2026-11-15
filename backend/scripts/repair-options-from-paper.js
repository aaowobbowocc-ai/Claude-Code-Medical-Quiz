#!/usr/bin/env node
/**
 * 照考選部原卷修選項 —— 只修三種**判準明確**的壞法，其餘交給人看。
 *
 *   1. 整組錯位：四個選項的內容都在，但掛錯字母。答案字母來自考選部答案卷，
 *      是照**原卷的字母**給的，所以掛錯字母＝答案整題錯。
 *        諮商心理 103030 心理健康與變態心理學 #2
 *          原卷 A①④ B①② C②④ D②③ ／ 題庫 A②③ B①④ C①② D②④
 *   2. 選項開頭多了一個字母：題庫的 A 寫成「D聲門週期(glottal period)」，
 *      多出來的字母是上一欄的選項標記被當成內文收進來。
 *   3. 選項開頭多了一段、而且那一段是**上一個選項的尾巴**：
 *        聽力師 100090 行為聽力學 #61
 *          C「…以增加兒童的」    ← 被截斷
 *          D「反應次數 一般而言…」← 多出來的「反應次數」是 C 的結尾
 *      把那一段搬回上一個選項。
 *
 * 三種都要求原卷那個選項是**完整的一行**（後面緊接著下一個標記或下一題），
 * 不然拿半行去覆蓋會把題庫原本正確的下半段砍掉。
 *
 *   node scripts/repair-options-from-paper.js [--exam=xxx] [--kind=rotate|letter|spill] [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { nz, decode, readPaperOptions } = require('./lib/moex-paper-options');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];
const onlyKind = (process.argv.find(a => a.startsWith('--kind=')) || '').split('=')[1];
const KEYS = ['A', 'B', 'C', 'D'];

(async () => {
  const mupdf = await import('mupdf');
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f));
  const tally = {};
  let changed = 0;

  for (const f of files) {
    const exam = f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '');
    if (only && exam !== only) continue;
    if (exam === 'gsat' || exam === 'ast') continue;
    const fp = path.join(BK, f);
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions; if (!arr) continue;

    const groups = {};
    for (const q of arr) (groups[q.exam_code + '|' + q.subject] = groups[q.exam_code + '|' + q.subject] || []).push(q);
    let touched = false;

    for (const key of Object.keys(groups)) {
      const [code, ...rest] = key.split('|');
      const subject = rest.join('|');
      const items = groups[key];
      // 先看這一卷有沒有可能有事：全部都對得上就不必抓 PDF
      let paper;
      try {
        const p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items });
        if (!p) continue;
        const buf = await fetchSheet('Q', code, p.c, p.s);
        if (!buf) continue;
        paper = readPaperOptions(mupdf, buf);
      } catch { continue; }
      if (!paper.ok) continue;

      for (const q of items) {
        const got = paper.opts[+q.number]; if (!got) continue;
        const bank = q.options || {};
        // 題號要先對得上，否則是「整題排錯位置」，不是選項壞掉
        const bStem = nz(String(q.question || '').replace(/^【題組情境】/, '')).slice(0, 10);
        const pStem = nz(paper.stems[+q.number] || '');
        if (!(bStem.length >= 6 && pStem.length >= 6
          && (pStem.includes(bStem) || nz(q.question).includes(pStem.slice(0, 10))))) continue;

        const head = k => (got[k] ? nz(got[k].raw) : '');
        const full = k => !!(got[k] && got[k].next && got[k].next !== 'text');
        const mine = k => nz(bank[k]);
        const mismatch = KEYS.filter(k => head(k).length >= 2 && !mine(k).startsWith(head(k)));
        if (!mismatch.length) continue;

        // ── 0. 題庫寫 (圖)、原卷其實是圈號組合 ───────────────────────
        /*
         * incomplete='image_options' 是「選項是圖、抓不到文字」的保守標記。
         * 其中有一批其實不是圖，是**組合題的圈號**被字型丟進私用區，解析器
         * 看不懂就填了「(圖)」（聽語 101110 #73/#75~#77 已經人工核過一輪）。
         * 原卷解得出四個互不相同、而且只由圈號與連接詞組成的選項就可以直接填回去。
         * 內部有重複圈號（①①）的是字型壓壞，不收。
         */
        if (KEYS.every(k => /^\(圖\)$/.test(String(bank[k] || '').trim()))
            && (!onlyKind || onlyKind === 'circled')) {
          const vals = KEYS.map(k => (got[k] ? decode(got[k].fullRaw).trim() : ''));
          const onlyCircles = vals.every(v => v && /^[①-⑳][①-⑳、，和及僅只\s]*$/.test(v)
            && !/([①-⑳])[\s、，和及僅只]*\1/.test(v));
          if (onlyCircles && new Set(vals).size === 4) {
            console.log(`${APPLY ? '✓' : '·'} [(圖)其實是圈號] ${exam} ${code} ${subject} #${q.number} ans=${q.answer}` +
              `  → ${vals.join(' / ')}`);
            if (APPLY) {
              KEYS.forEach((k, i) => { q.options[k] = vals[i]; });
              if (q.incomplete === 'image_options') delete q.incomplete;
              touched = true; changed++;
            }
            tally['(圖)其實是圈號'] = (tally['(圖)其實是圈號'] || 0) + 1;
            continue;
          }
        }

        // ── 1. 整組錯位 ──────────────────────────────────────────────
        // 四個字母的內容全部都能在題庫裡找到，只是掛在別的字母上。
        const perm = {};
        let rotate = KEYS.every(k => {
          if (!head(k)) return false;
          const at = KEYS.find(o => mine(o).startsWith(head(k)));
          if (!at) return false;
          perm[k] = at; return true;
        }) && new Set(Object.values(perm)).size === 4 && KEYS.some(k => perm[k] !== k);
        // 只在原卷四個選項都是完整一行時才重排 —— 不然會把題庫的續行內容洗掉
        if (rotate && !KEYS.every(full)) rotate = false;
        if (rotate && (!onlyKind || onlyKind === 'rotate')) {
          const next = {};
          for (const k of KEYS) next[k] = bank[perm[k]];
          console.log(`${APPLY ? '✓' : '·'} [整組錯位] ${exam} ${code} ${subject} #${q.number} ans=${q.answer}`);
          for (const k of KEYS) console.log(`    ${k}: ${JSON.stringify(bank[k])} → ${JSON.stringify(next[k])}`);
          if (APPLY) { q.options = next; touched = true; changed++; }
          tally['整組錯位'] = (tally['整組錯位'] || 0) + 1;
          continue;
        }

        // ── 2. 開頭多一個字母 ────────────────────────────────────────
        /*
         * ⚠️ 字型沒有對應時，mupdf 會把那個字**整個丟掉**（不是留下私用區碼位）：
         *   「C-reactive protein」在原卷的文字層就是「-reactive protein」，
         *   題庫的 C 才是對的。照著「題庫比原卷多一個字母」去砍會砍掉本文。
         * 真正多出來的那個字母後面一定跟著**空白**（上一欄的選項標記被當成內文
         * 收進來時，標記與本文之間的那一格會留下）：
         *   「D 聲門週期（glottal period）」「d 上收縮肌」 ← 要修
         *   「C-reactive protein」「A、B、C型流行性感冒病毒」 ← 不要動
         */
        const letterFix = mismatch.filter(k =>
          /^[A-Da-d]\s/.test(String(bank[k] || '').trim())
          && nz(String(bank[k]).trim().slice(1)).startsWith(head(k)));
        if (letterFix.length === mismatch.length && (!onlyKind || onlyKind === 'letter')) {
          console.log(`${APPLY ? '✓' : '·'} [開頭多字母] ${exam} ${code} ${subject} #${q.number}`);
          for (const k of letterFix) {
            const after = String(bank[k]).trim().slice(1).replace(/^\s+/, '');
            console.log(`    ${k}: ${JSON.stringify(bank[k])} → ${JSON.stringify(after)}`);
            if (APPLY) { q.options[k] = after; touched = true; changed++; }
          }
          tally['開頭多字母'] = (tally['開頭多字母'] || 0) + 1;
          continue;
        }

        // ── 3. 開頭多了上一個選項的尾巴 ──────────────────────────────
        const spill = [];
        for (const k of mismatch) {
          const prev = KEYS[KEYS.indexOf(k) - 1]; if (!prev) { spill.length = 0; break; }
          const raw = String(bank[k] || '');
          const h = head(k);
          // 在題庫這一格裡找到原卷的開頭，前面那一段就是溢出的
          let cut = -1;
          for (let i = 1; i <= raw.length; i++) if (nz(raw.slice(i)).startsWith(h)) { cut = i; break; }
          if (cut <= 0 || cut > 30) { spill.length = 0; break; }
          const moved = raw.slice(0, cut).trim();
          /*
           * 搬過去之後要「接得起來」：接好的上一個選項必須是**原卷那個選項的開頭**。
           * 只檢查「還是以原卷開頭起頭」是沒有用的 —— 本來就會成立。
           */
          const prevFullPaper = got[prev] ? nz(got[prev].fullRaw) : '';
          const joined = nz(String(bank[prev] || '') + moved);
          if (!prevFullPaper || !prevFullPaper.startsWith(joined)) { spill.length = 0; break; }
          spill.push({ k, prev, moved, rest: raw.slice(cut).replace(/^\s+/, '') });
        }
        // ── 4. 整組往後位移、最後一個選項掉了 ───────────────────────
        /*
         * 台鐵／警特／關務的法科整批是這個樣子：某一個選項在原卷上換了行，
         * 解析時被當成兩個選項，後面每一格往後擠一位，最後一格**整個不見**。
         *   台鐵 100110 法學大意 #13
         *     原卷 A「失蹤滿3年後…為70歲以上的人」B「失蹤人失蹤滿7年後…」…
         *     題庫 A「失蹤滿3年後…為」B「70歲以上的人」C=原卷B D=原卷C（原卷D 不見了）
         *   答案字母照原卷給 → 整題答案都是錯的。
         *
         * 這種只能整組照原卷重建。護欄：題庫現有的每一段都必須**找得到出處**
         * （是原卷四個選項串起來的子字串），否則就是對到別張卷，不能覆蓋。
         */
        if (!spill.length && (!onlyKind || onlyKind === 'rebuild')) {
          const complete = KEYS.every(k => got[k] && nz(got[k].fullRaw).length >= 2);
          /*
           * 護欄要夠窄才敢自動覆蓋。用的是這個壞法**自己的簽章**：
           * 題庫四格接起來，必須正好是原卷四格接起來的**開頭**。
           *   台鐵 100110 法學大意 #13
           *     題庫 A+B＝原卷 A，題庫 C＝原卷 B，題庫 D＝原卷 C（原卷 D 掉了）
           *     → 接起來剛好是原卷的前三格，是 paperCat 的前綴。
           * 成立就代表「題庫的每一個字都在原卷上、順序也對，只是切錯格」，
           * 覆蓋不會弄丟任何東西。改用「每一段都找得到出處」那種寬鬆判準時，
           * 聽語 100140 嗓音 #3 的「僅①／僅①③」也會過關 —— 那題其實是別的壞法。
           */
          const bankCat = KEYS.map(mine).join('');
          const paperCat = KEYS.map(k => (got[k] ? nz(got[k].fullRaw) : '')).join('');
          const sourced = bankCat.length >= 12 && paperCat.startsWith(bankCat);
          /*
           * 組合題（選項是「①②」「僅③」這種代號）不走重建。
           * 「題庫的每一段都找得到出處」對它們形同虛設 ——「①②」本來就是
           * 「①②③④」的子字串，隨便一組都通得過；而原卷的圈號正是最容易被
           * 字型壓壞的東西（project_circled_option_collapse）。這一類留在報告裡人看。
           */
          const solid = s => (String(s).match(/[㐀-鿿぀-ヿA-Za-z]/g) || []).length;
          const textual = KEYS.some(k => got[k] && solid(got[k].fullRaw) >= 6);
          // 原卷自己解析壞掉的（圈號全塌成「111」、四格一模一樣）不能拿來覆蓋；
          // 續行黏過頭（黏到下一題）也要擋：選項不會有 300 字，也不會夾著題號。
          const sane = complete && KEYS.every(k => got[k])
            && new Set(KEYS.map(k => nz(got[k].fullRaw))).size === 4
            && KEYS.every(k => got[k].fullRaw.length <= 300
              && !/\s\d{1,3}\s*[.、．]\s*\S/.test(got[k].fullRaw)
              // 圈號被字型全壓成同一個（見 project_circled_option_collapse）：
              // 原卷解出「①①①」就不能拿來覆蓋題庫的「②④⑤」。
              && !/([①-⑳])\1/.test(got[k].fullRaw));
          if (complete && sourced && sane && textual) {
            const next = {};
            for (const k of KEYS) next[k] = got[k].fullRaw.replace(/\s+/g, ' ').trim();
            console.log(`${APPLY ? '✓' : '·'} [整組重建] ${exam} ${code} ${subject} #${q.number} ans=${q.answer}`);
            for (const k of KEYS) console.log(`    ${k}: ${JSON.stringify(bank[k])} → ${JSON.stringify(next[k])}`);
            if (APPLY) { q.options = next; touched = true; changed++; }
            tally['整組重建'] = (tally['整組重建'] || 0) + 1;
            continue;
          }
        }
        if (spill.length && (!onlyKind || onlyKind === 'spill')) {
          console.log(`${APPLY ? '✓' : '·'} [尾巴掉到下一格] ${exam} ${code} ${subject} #${q.number}`);
          for (const s of spill) {
            console.log(`    ${s.prev} += ${JSON.stringify(s.moved)}   ${s.k}: 去掉開頭`);
            if (APPLY) {
              q.options[s.prev] = String(q.options[s.prev] || '') + s.moved;
              q.options[s.k] = s.rest;
              touched = true; changed++;
            }
          }
          tally['尾巴掉到下一格'] = (tally['尾巴掉到下一格'] || 0) + 1;
        }
      }
    }
    if (APPLY && touched) fs.writeFileSync(fp, JSON.stringify(j, null, 2) + '\n');
  }
  console.log(`\n${APPLY ? '已改' : '可改'} ${changed} 處`, JSON.stringify(tally));
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})();
