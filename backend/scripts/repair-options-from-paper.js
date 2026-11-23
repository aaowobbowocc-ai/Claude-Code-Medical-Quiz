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
 *   node scripts/repair-options-from-paper.js [--exam=xxx] [--kind=…] [--apply]
 *     --kind: circled | rotate | letter | truncated | spill | rebuild | alien
 *             alien-cell | alien-cell-headless | alien-cell-fragment（可自動套用）
 *             alien-cell-replaced（只報告，要 --reviewed 才寫入）
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { nz, decode, readPaperOptions } = require('./lib/moex-paper-options');
const { answerMap } = require('./lib/moex-answer-geo');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];
const onlyKind = (process.argv.find(a => a.startsWith('--kind=')) || '').split('=')[1];
// 「整格換掉」那一類的風險太高，要逐題核對過才寫入（見 2.8 的註解）
const REVIEWED = process.argv.includes('--reviewed');
// 把 2.8「整格換掉」的候選連同判斷依據倒成 JSONL，拿去分風險層級
const JSONL = (process.argv.find(a => a.startsWith('--jsonl=')) || '').split('=')[1];
const jsonlRows = [];
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
      let paper, resolved;
      try {
        const p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items });
        if (!p) continue;
        const buf = await fetchSheet('Q', code, p.c, p.s);
        if (!buf) continue;
        paper = readPaperOptions(mupdf, buf);
        resolved = p;
      } catch { continue; }
      if (!paper.ok) continue;
      /*
       * 99 年考選部把題目與答案印在同一份 PDF（見 project_year_99_coverage）。
       * 原本只擋「要寫進去的那一格」含 <正確答案>，但同一張卷的別格也可能夾著，
       * 所以整卷標記，後面照抄之前先看這一面旗子。
       */
      const paperLeaksAnswer =
        Object.values(paper.opts || {}).some(o => Object.values(o || {})
          .some(c => /<正確答案>/.test(String((c && c.fullRaw) || '')))) ||
        Object.values(paper.stems || {}).some(t => /<正確答案>/.test(String(t || '')));
      /*
       * 選項整組換掉時，答案字母就不能假設還是對的 —— 它當初是跟著**錯的選項**
       * 存進來的（police4 106070 英文 #36 題庫寫 D，原卷選項換成正確的四個之後
       * 對應的是別的字母）。只好回頭抓考選部的答案卷。
       * 延遲抓：整卷沒有這類候選時完全不碰網路。
       */
      let ansMap;
      const officialAnswer = async n => {
        if (ansMap === undefined) {
          ansMap = null;
          try {
            const expected = Math.max(...items.map(q => +q.number || 0));
            // t=S 答案卷優先、拿不到再退到 t=A 全類科清冊（舊年度只有清冊）
            const r = await answerMap(code, resolved.c, resolved.s, expected, resolved.subject);
            if (r && r.map && r.map.size) ansMap = r.map;
          } catch { /* 沒有答案卷 */ }
        }
        return ansMap ? ansMap.get(n) : undefined;
      };

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

        // ── 2.5 題庫這一格被切掉後半 ─────────────────────────────────
        /*
         * 題庫的選項是原卷那一格的**開頭**，後面整段不見：
         *   dental1 112020 卷二 #46 A
         *     原卷「長石系陶瓷具有良好的美觀性，可用於前牙牙冠鑲面（veneer）」
         *     題庫「長石系陶瓷具有良好的美觀性，可用」
         * 使用者看到的是半句話。判準是這個壞法自己的簽章——**題庫是原卷的前綴**，
         * 所以補回去只會長出東西，不會改掉任何既有的字。
         *
         * 原卷那一格仍要通過理智檢查：選項不會有 200 字，中間也不會夾著題號
         * （續行黏到下一題時會）。
         */
        const paperFull = k => (got[k] ? nz(got[k].fullRaw) : '');
        const truncFix = mismatch.filter(k =>
          mine(k).length >= 10
          && paperFull(k).length > mine(k).length
          && paperFull(k).startsWith(mine(k))
          && got[k].fullRaw.length <= 200
          && !/\s\d{1,3}\s*[.、．]\s*\S/.test(got[k].fullRaw));
        if (truncFix.length === mismatch.length && (!onlyKind || onlyKind === 'truncated')) {
          console.log(`${APPLY ? '✓' : '·'} [被切掉後半] ${exam} ${code} ${subject} #${q.number}`);
          for (const k of truncFix) {
            const after = got[k].fullRaw.replace(/\s+/g, ' ').trim();
            console.log(`    ${k}: ${JSON.stringify(bank[k])} → ${JSON.stringify(after)}`);
            if (APPLY) { q.options[k] = after; touched = true; changed++; }
          }
          tally['被切掉後半'] = (tally['被切掉後半'] || 0) + 1;
          continue;
        }

        // ── 2.8 這一格被同題別格的碎片取代 ──────────────────────────
        /*
         * pt 112100 物理治療技術學 #36（使用者回報 id 966）
         *   原卷 B「測試肌力等級3～5時…前臂旋後（supination），主要是要測試brachialis」
         *   題庫 B「rachioradialis」  ← 是 C 續行尾巴「…brachioradialis」少一個字母
         * 答案正好是 B，所以使用者看到的是「正確答案只有一個單字」。
         *
         * 跟「被切掉後半」的差別：那種題庫是原卷的**前綴**（只少不多），
         * 這種題庫那一格跟原卷**完全無關**，是別格漏過來的碎片。
         *
         * 共同判準：只有這一格對不上（另外三格還能前綴對上原卷 → 卷沒抓錯、
         * 題號沒錯位），題庫這一格的內容在**原卷同一題的四格裡找得到**
         * （→ 覆蓋不會弄丟任何字），原卷這一格是完整一行（next !== 'text'）。
         *
         * 然後分成兩種，因為風險差很多（2026-11-21 全站實測 3,764 題）：
         *
         *   alien-cell（193 題，可自動套用）
         *     原卷那一格**以題庫這一格結尾**，只多出 1-2 個字 ——
         *     就是「開頭字母被選項標記吃掉」：opamine→Dopamine、ctivity→activity、
         *     DP直接與游離之Pi→ADP直接與游離之Pi。補回去只長出那 1-2 個字。
         *
         *   alien-cell-replaced（3,571 題，**預設只報告**，要 --reviewed 才寫入）
         *     原卷那一格是**完全不同的內容**，等於把遺失的選項救回來。方向通常對，
         *     但不能整批自動做：
         *       · dental1 106100 卷二 #67 題庫 A「moxicillin」→ 原卷 A「Ampicillin」
         *         Amoxicillin 與 Ampicillin 是不同的藥，誰對要逐題看
         *       · **dental1 099020 的試題 PDF 本身夾著「<正確答案>」標記**
         *         （99 年考選部把題目與答案印在同一份），照抄會把答案寫進選項
         *     pt 的 11 題是逐題核對原卷後用 --reviewed 套用的。
         */
        if (mismatch.length === 1 && (!onlyKind || /^alien-cell/.test(onlyKind))) {
          const k = mismatch[0];
          const cat = KEYS.map(x => (got[x] ? nz(got[x].fullRaw) : '')).join('');
          const v = mine(k);
          const want = paperFull(k);
          const isAlien = v.length >= 4 && v.length <= 60 && cat.includes(v)
            && !want.startsWith(v) && !v.startsWith(head(k))
            && full(k) && want.length >= 6 && got[k].fullRaw.length <= 200
            // 原卷這一格不能夾著答案，也不能夾著題號（夾題號＝續行黏到下一題了）
            && !paperLeaksAnswer && !/正確答案|【答案】/.test(want)
            && !/\s\d{1,3}\s*[.、．]\s*\S/.test(got[k].fullRaw);
          // 只補回開頭的 1-2 個字＝不會改掉任何既有的字
          const narrow = isAlien && want.endsWith(v) && want.length - v.length <= 2;
          /*
           * 要不要自動套用，看「題庫這一格的字是從哪裡來的」——能指出來源，
           * 就證明這一格是碎片（垃圾），覆蓋它不會弄丟任何原本正確的字：
           *
           *   headless  v 整段就在原卷這一格裡（只是開頭被切掉）
           *             doctor2 112080 醫學(四) #45 D
           *               題庫「S2-VASc分數為0分之非瓣膜性心房顫動…」
           *               原卷「CHA2DS2-VASc分數為0分之非瓣膜性心房顫動…」
           *             覆蓋後是原本內容的超集，等於 2.5「被切掉後半」的鏡像。
           *
           *   fragment  v 在同題**別格**裡找得到 ＝ 別格漏過來的碎片
           *             ot 106020 生理疾病職能治療學 #49 C
           *               題庫「lassIV無法達成大於2METs之活動」← D 少第一個字
           *               原卷「ClassIII可行走大約2.5英里之距離」← 真正的 C
           *             這一型最多，而且常常壞在正確答案那一格（使用者看到
           *             正確答案是半截亂碼）。2026-11-21 擔心的
           *             dental1「moxicillin→Ampicillin 誰對」其實不是兩說：
           *             moxicillin 是別格 Amoxicillin 的碎片，原卷那一格才是真的。
           *
           *   replaced  兩者都指不出來 ＝ v 要跨格拼接才找得到（多半是兩格黏在
           *             一起）。方向大概也對，但**留著人看**，要 --reviewed 才寫。
           */
          const headless = isAlien && want.includes(v);
          const fromOther = isAlien && KEYS.some(x => x !== k && paperFull(x).includes(v));
          const slug = narrow ? 'alien-cell'
            : headless ? 'alien-cell-headless'
            : fromOther ? 'alien-cell-fragment'
            : 'alien-cell-replaced';
          const kind = {
            'alien-cell': '別格的碎片',
            'alien-cell-headless': '開頭被切掉',
            'alien-cell-fragment': '別格的碎片（整格換掉）',
            'alien-cell-replaced': '整格換掉（指不出來源）',
          }[slug];
          if (isAlien && (!onlyKind || onlyKind === slug)) {
            const after = got[k].fullRaw.replace(/\s+/g, ' ').trim();
            const write = APPLY && (slug !== 'alien-cell-replaced' || REVIEWED);
            if (JSONL) {
              // v 是從哪一格漏過來的？是不是那一格的結尾？——分風險層級要靠這個
              const src = KEYS.filter(x => x !== k && paperFull(x).includes(v));
              jsonlRows.push({
                exam, code, subject, n: +q.number, id: q.id, ans: q.answer, k, narrow,
                v, want, src, srcTail: src.filter(x => paperFull(x).endsWith(v)),
                inSelf: paperFull(k).includes(v), leaky: paperLeaksAnswer,
                bank: KEYS.map(x => nz(bank[x])), paper: KEYS.map(x => paperFull(x)),
              });
            }
            console.log(`${write ? '✓' : slug === 'alien-cell-replaced' ? '?' : '·'} [${kind}] ${exam} ${code} ${subject} #${q.number} ans=${q.answer}`);
            console.log(`    ${k}: ${JSON.stringify(bank[k])} → ${JSON.stringify(after)}`);
            if (write) { q.options[k] = after; touched = true; changed++; }
            tally[kind] = (tally[kind] || 0) + 1;
            continue;
          }
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
        if (!spill.length && (!onlyKind || onlyKind === 'rebuild' || onlyKind === 'alien')) {
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

          // ── 5. 四個選項整組是別題的 ────────────────────────────────
          /*
           * 題幹對得上，四個選項卻跟原卷**毫無關係**：
           *   聽力師 102030 行為聽力學 #20
           *     題庫 A「Frequency in Hertz (Hz)」B「Hearing Threshold Levels…」
           *          ← 這是聽力圖的座標軸標籤，爬蟲把圖上的字當成選項收了
           *     原卷 A「250Hz, 1000Hz, 4000Hz」…
           *   聽力師 104100 #57：題庫整組是隔壁題的選項。
           * 答案字母來自考選部答案卷、是跟著**題號**走的，所以字母留著、
           * 只換文字，整題就對了。
           *
           * 這一類沒有「前綴」那種簽章可用，唯一的依據是題幹。10 個字的門檻
           * 在這裡太鬆 ——「下列敘述何者錯誤？」這種題幹滿卷都是，配錯了就
           * 把四個選項整組換成別題的。所以改成**兩邊各取 16 字互相包含**。
           */
          const bFull = nz(String(q.question || '').replace(/^【題組情境】/, ''));
          const pFull = nz(paper.stems[+q.number] || '');
          const stemStrict = bFull.length >= 16 && pFull.length >= 16
            && pFull.includes(bFull.slice(0, 16)) && bFull.includes(pFull.slice(0, 16));
          /*
           * 「毫無關係」不能只檢查互為子字串。原卷自己解壞的時候，兩邊會長得
           * 幾乎一樣卻又不互相包含：
           *   nursing 104100 基礎醫學 #76
           *     題庫「A、B、C型流行性感冒病毒」 ← 對的
           *     原卷「、B、C 型流行性感冒病毒A」 ← 開頭的 A 被字型丟掉、跑到尾巴
           * 照這個「不符」去覆蓋會把對的題庫改壞。改用最長共同子字串：
           * 兩邊有六成以上的字連在一起相同，就不是別題，是同一句話的兩種解法。
           */
          const lcs = (a, b) => {
            let best = 0;
            const dp = new Array(b.length + 1).fill(0);
            for (let i = 1; i <= a.length; i++) {
              let diag = 0;
              for (let j = 1; j <= b.length; j++) {
                const tmp = dp[j];
                dp[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
                if (dp[j] > best) best = dp[j];
                diag = tmp;
              }
            }
            return best;
          };
          const unrelated = KEYS.every(k => {
            const m = mine(k), h = paperFull(k);
            if (m.length < 4 || h.length < 4) return false;
            if (m.includes(h) || h.includes(m)) return false;
            if (lcs(m, h) >= Math.min(m.length, h.length) * 0.6) return false;
            return !KEYS.some(o => mine(o).startsWith(head(k)));
          });
          /*
           * 題庫寫「（見圖 A）」是**刻意**的：題幹明說「完整選項見下圖」，
           * 選項本來就在圖上。換成文字反而跟題幹打架。
           * 原卷解出豆腐字（字型沒有對應）的也不能拿來覆蓋。
           */
          const placeholder = KEYS.some(k => /^[（(]\s*見圖/.test(String(bank[k] || '').trim()));
          const garbled = KEYS.some(k => !got[k] || /[�]|[-]/.test(decode(got[k].fullRaw)));
          /*
           * 四格長度要相稱。整組換掉是最沒有「簽章」可憑的一種修法，唯一還能
           * 看的是版面常識：同一題的四個選項不會一個 12 字、一個 120 字。
           * 長度爆掉＝那一格把後面的東西吸進來了（警特四等 111070 英文 #36 的
           * D 吸到下一篇克漏字的本文），不能拿來覆蓋題庫。
           */
          const lens = KEYS.map(k => paperFull(k).length);
          const balanced = Math.max(...lens) <= Math.min(...lens) * 2 + 12;
          if (stemStrict && unrelated && complete && sane && textual && balanced
              && !placeholder && !garbled
              && (!onlyKind || onlyKind === 'alien')) {
            /*
             * 答案一定要拿考選部答案卷重新對一次。答案欄不是單一個 A~D 的
             * （「#」、送分、一律給分）就整題跳過，交給人看 —— 那是爭議題，
             * 規則見 feedback_official_corrections。
             */
            const off = await officialAnswer(+q.number);
            if (!off || !/^[A-D]$/.test(String(off).trim())) {
              tally['整組是別題的(查不到官方答案，跳過)'] = (tally['整組是別題的(查不到官方答案，跳過)'] || 0) + 1;
              continue;
            }
            const ans = String(off).trim();
            const next = {};
            for (const k of KEYS) next[k] = got[k].fullRaw.replace(/\s+/g, ' ').trim();
            console.log(`${APPLY ? '✓' : '·'} [整組是別題的] ${exam} ${code} ${subject} #${q.number} ` +
              `ans=${q.answer}${ans !== q.answer ? ` → ${ans}` : ''}`);
            console.log(`    題幹: ${JSON.stringify(String(q.question).slice(0, 60))}`);
            for (const k of KEYS) console.log(`    ${k}: ${JSON.stringify(bank[k])} → ${JSON.stringify(next[k])}`);
            const answerMoved = ans !== q.answer;
            if (APPLY) {
              q.options = next;
              if (answerMoved) q.answer = ans;
              touched = true; changed++;
            }
            tally['整組是別題的'] = (tally['整組是別題的'] || 0) + 1;
            if (answerMoved) tally['其中答案也改了'] = (tally['其中答案也改了'] || 0) + 1;
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
  if (JSONL) {
    fs.writeFileSync(JSONL, jsonlRows.map(r => JSON.stringify(r)).join('\n') + '\n');
    console.log('JSONL:', JSONL, jsonlRows.length, '筆');
  }
  console.log(`\n${APPLY ? '已改' : '可改'} ${changed} 處`, JSON.stringify(tally));
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})();
