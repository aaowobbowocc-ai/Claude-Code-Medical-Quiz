#!/usr/bin/env node
/**
 * 補學測／分科（大考中心）「題幹提到圖卻沒有圖」的題。
 *
 * 版型與考選部不同，**圖通常放在選項右邊**（雙欄），不是夾在題幹與選項之間：
 *
 *   x=85  y=88   "5. 圖2 為玉山海拔高度的剖面示意圖，甲~戊分別代表不同的生態系。某生態系中的植"
 *   x=103 y=122  "(A)甲"        x=365 y=129 "海拔高度（m）"   ← 圖的標籤在右欄
 *   x=103 y=139  "(B)乙"        x=449 y=142 "甲"
 *
 * 所以 extract-missing-figures.js 那套「題幹與第一個選項之間的空白帶」在這裡抓不到東西。
 * 三段式定位，由準到糙：
 *   1. **圖說定位**（最準）：題幹寫「圖8」，PDF 裡就有一行「圖8」排在圖的正下方。
 *      圖說還可能不在題號那一頁（題組共用圖），所以裁圖要用圖說的頁碼。
 *   2. 右欄有文字 → 裁右半邊，y 取該題範圍
 *   3. 都沒有 → 退回「題幹與第一個選項之間的空白帶」（圖在題幹下方）
 *
 * 只用第 2 種會裁到選項與頁碼——gsat 103 社會 #70 實測裁出「(D)卯」和「- 14 -」。
 *
 * 試題 PDF 網址取自 scrape-ceec.js 的 REGISTRY，不另外抄一份。
 *
 *   node scripts/extract-ceec-figures.js [--exam gsat] [--year 100] [--limit 20] [--apply]
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { REGISTRY, BASE } = require('./scrape-ceec');
const { needsImage } = require('./lib/image-ref');

const BK = path.join(__dirname, '..');
const IMG = path.join(BK, '..', 'frontend', 'public', 'question-images');
const CACHE = path.join(BK, '_tmp', 'ceec-pdf');
const APPLY = process.argv.includes('--apply');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const onlyExam = arg('exam'), onlyYear = arg('year');
const LIMIT = +(arg('limit') || 0);

// 題庫裡的中文科目名 → REGISTRY 的 tag
const SUBJ = {
  國文: 'zh', 英文: 'en', 社會: 'social', 自然: 'science',
  歷史: 'history', 地理: 'geography', 公民: 'civics', 公民與社會: 'civics',
  物理: 'physics', 化學: 'chemistry', 生物: 'biology', 數學甲: 'mathA', 數學乙: 'mathB',
};
const SPLIT_X = 320;          // 分欄線：右欄 x ≥ 這個值
const SCALE = 2;

/**
 * 掃出所有圖說行（整行就是「圖8」或「表一」）。
 * 大考中心的圖說固定排在圖的正下方，是定位圖片最可靠的錨點。
 *
 * 圖說編號有兩種寫法，同一份卷只用其中一種：
 *   100 學測自然「圖2」（阿拉伯）、100 學測社會「圖二」（中文）
 * 只認阿拉伯數字的話，社會科整批定位不到圖說，只能退回比較糙的右欄模式。
 */
const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function figNum(s) {
  const t = String(s).trim();
  if (/^\d{1,2}$/.test(t)) return +t;
  if (/^十[一二三四五六七八九]$/.test(t)) return 10 + CN[t[1]];
  if (/^[一二三四五六七八九]十$/.test(t)) return CN[t[0]] * 10;
  return CN[t] || null;
}
const FIGNO = '(\\d{1,2}|[一二三四五六七八九十]{1,3})';

function capsOf(pages) {
  // 圖說有三種寫法，同一份卷可能混用：
  //   「圖2」          純編號（最常見）
  //   「圖一：高中生政治知識的分布」  編號＋標題（100 學測社會、113 分科歷史的表）
  //   「圖3a」「圖9b」 子圖，題幹只寫「圖3」
  // 原本只認第一種，於是分科有 52 題被判「題幹指名的圖說找不到」。
  // ⚠️ 不能放寬成「圖N 後面接任何東西」—— 題幹本身就長這樣
  //  （「圖3 描繪十八世紀末亞洲某港口的景象。該國政府鑑於外商日多…」），
  //   那會把題幹自己當成圖說。所以只認「冒號」與「單一英文字母子圖」兩種結尾。
  const pure = new RegExp('^([圖表])\\s*' + FIGNO + '\\s*$');
  const titled = new RegExp('^([圖表])\\s*' + FIGNO + '\\s*[：:]');
  const sub = new RegExp('^([圖表])\\s*' + FIGNO + '\\s*[a-zA-Z]\\s*$');
  // 第四種：「表2 某項疾病盛行率（罹病人口的百分比）」—— 編號後面直接接標題、沒有冒號。
  // 這種跟題幹的開頭長得一樣（「表1 中的平均距離、質量、公轉週期…」），所以**只靠版面分**：
  //   圖說是置中的短行（x ≥ 150、長度 ≤ 24 字），題幹是貼左邊界的長行。
  const loose = new RegExp('^([圖表])\\s*' + FIGNO + '\\s');
  const out = [];
  pages.forEach((ls, pg) => ls.forEach(l => {
    const t = l.t.trim();
    const looseOk = loose.test(t) && l.x >= 150 && t.length <= 24;
    const shape = pure.test(t) ? '純編號' : sub.test(t) ? '子圖'
      : titled.test(t) ? '編號加標題' : looseOk ? '編號加標題(無冒號)' : null;
    if (!shape) return;
    const m = pure.exec(t) || sub.exec(t) || titled.exec(t) || loose.exec(t);
    const n = figNum(m[2]);
    if (n) out.push({ pg, x: l.x, y: l.y, h: l.h, kind: m[1], n, shape });
  }));
  return out;
}

function download(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'user-agent': 'Mozilla/5.0' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location)
        return download(new URL(r.headers.location, url).href).then(res, rej);
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode)); }
      const c = []; r.on('data', d => c.push(d)); r.on('end', () => res(Buffer.concat(c)));
    }).on('error', rej);
  });
}

async function pdfFor(exam, year, tag) {
  const entry = REGISTRY[exam] && REGISTRY[exam].years[year] && REGISTRY[exam].years[year][tag];
  if (!entry || !entry.q) return null;
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, `${exam}_${year}_${tag}.pdf`);
  if (fs.existsSync(f) && fs.statSync(f).size > 10000) return fs.readFileSync(f);
  const buf = await download(BASE + entry.q);
  fs.writeFileSync(f, buf);
  return buf;
}

(async () => {
  const sharp = require('sharp');
  const mupdf = await import('mupdf');
  const stats = { made: 0, skip: 0 }, why = {};
  const bump = k => { why[k] = (why[k] || 0) + 1; stats.skip++; };

  for (const [exam, file] of [['gsat', 'questions-gsat.json'], ['ast', 'questions-ast.json']]) {
    if (onlyExam && exam !== onlyExam) continue;
    const p = path.join(BK, file);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = Array.isArray(raw) ? raw : raw.questions;
    const targets = arr.filter(q => !(q.images && q.images.length) && !q.image_url
      && !q.no_image_in_source && needsImage(q));
    const groups = {};
    for (const q of targets) {
      const year = String(q.exam_code || '').replace(/^(gsat|ast)_/, '');
      const tag = SUBJ[q.subject];
      if (!tag) { bump('科目名對不到 tag: ' + q.subject); continue; }
      if (onlyYear && year !== onlyYear) continue;
      (groups[`${year}|${tag}`] = groups[`${year}|${tag}`] || []).push(q);
    }

    let touched = false;
    for (const key of Object.keys(groups)) {
      const [year, tag] = key.split('|');
      let doc;
      try {
        const buf = await pdfFor(exam, year, tag);
        if (!buf) { groups[key].forEach(() => bump(`REGISTRY 沒有 ${exam} ${year} ${tag}`)); continue; }
        doc = mupdf.Document.openDocument(buf, 'application/pdf');
      } catch (e) { groups[key].forEach(() => bump('PDF 取得失敗: ' + e.message.slice(0, 30))); continue; }

      // 「嵌入圖片」這條路為什麼沒走成 —— 分開計數才知道要往哪裡調
      const figWhy = stats.figWhy || (stats.figWhy = {});
      const bumpFig = w => { figWhy[w] = (figWhy[w] || 0) + 1; };

      // 逐頁收行；同時收「嵌入圖片區塊」（'preserve-images' 才會吐 type!=='text'）
      const pages = [];
      const figBlocks = [];
      for (let pg = 0; pg < doc.countPages(); pg++) {
        try {
          const pageObj = doc.loadPage(pg);
          const si = JSON.parse(pageObj.toStructuredText('preserve-images').asJSON());
          // 頁面尺寸要從 getBounds() 拿；StructuredText 的 JSON 沒有 bbox 欄位，
          // 誤用會讓面積退成 1、每頁都被判成掃描檔（extract-missing-figures 踩過）
          const bnd = pageObj.getBounds();
          const area = (bnd && bnd.length === 4) ? Math.abs((bnd[2] - bnd[0]) * (bnd[3] - bnd[1])) : 0;
          const bs = (si.blocks || []).filter(b => b.type && b.type !== 'text' && b.bbox
            && b.bbox.w > 50 && b.bbox.h > 40);
          const scanned = area > 0 && bs.some(b => (b.bbox.w * b.bbox.h) > area * 0.6);
          if (!scanned) for (const b of bs) figBlocks.push({ pg, x: b.bbox.x, y: b.bbox.y, w: b.bbox.w, h: b.bbox.h });
        } catch { /* 這頁抽不出圖，走其他定位方式 */ }
        const st = JSON.parse(doc.loadPage(pg).toStructuredText('preserve-whitespace').asJSON());
        const ls = [];
        for (const b of st.blocks || []) for (const l of b.lines || []) {
          const t = (l.text || '').normalize('NFC');
          if (!t.trim()) continue;
          ls.push({ pg, x: l.bbox.x, y: l.bbox.y, w: l.bbox.w, h: l.bbox.h, t });
        }
        ls.sort((a, b) => a.y - b.y || a.x - b.x);
        pages.push(ls);
      }
      // 題號行：「5.」開頭且在左邊界
      const heads = [];
      pages.forEach((ls, pg) => ls.forEach(l => {
        const m = /^(\d{1,3})\s*[.、]/.exec(l.t.trim());
        if (m && l.x < 120) heads.push({ pg, y: l.y, h: l.h, n: +m[1] });
      }));

      for (const q of groups[key]) {
        if (LIMIT && stats.made >= LIMIT) break;
        const n = +q.number;
        const head = heads.find(h => h.n === n);
        if (!head) { bump('PDF 裡定位不到題號'); continue; }
        const nextHead = heads.find(h => (h.pg > head.pg) || (h.pg === head.pg && h.y > head.y + 5));
        const ls = pages[head.pg];
        const yTop = head.y, yBot = (nextHead && nextHead.pg === head.pg) ? nextHead.y : Infinity;
        const inRange = ls.filter(l => l.y >= yTop - 2 && l.y < yBot);
        // 右欄判定要先把「選項標籤」與「頁碼／頁首」排掉：
        // gsat 100 自然 #19 的右欄只有「(C)氫氧根離子」和「- 4 -」，
        // 不排掉就會裁出一張只有選項和頁碼的空圖。
        const NOISE = /^\(?[A-E][).]|^[-－]?\s*\d{1,3}\s*[-－]?$|^第\s*\d+\s*頁|^共\s*\d+\s*頁/;
        const rightLines = inRange.filter(l => l.x >= SPLIT_X && !NOISE.test(l.t.trim()));

        /*
         * 題組的圖排在**情境段裡**，位置在第一小題的題號之上
         *（gsat 101 社會 #23/#24 的圖在 y=167，兩題的題號在 375/480），
         * 所以搜尋上界要延伸到「題組第一小題的前一個題號」。
         *
         * **只有題組才延伸。** 一般題延伸上去就會抓到上一題的圖 ——
         * 那正是下面兩條退路被關掉的原因。題組的判定用我們自己存的
         * 【題組情境】標記：同一組的情境文字逐字相同，取最小題號當錨點。
         */
        let anchorHead = head;
        const groupNums = new Set();          // 同一題組的所有題號
        const ctx = /^【題組情境】/.test(String(q.question || '')) ? String(q.question).slice(0, 60) : null;
        if (ctx) {
          // 要用**整卷**的題去找題組的第一小題。只看 groups[key]（待補圖的那些）
          // 會在「第一小題已經有圖」時把錨點算到後面去，上界就延伸不到情境段。
          const sameGroup = arr.filter(x => x && x.exam_code === q.exam_code && x.subject === q.subject
            && String(x.question || '').slice(0, 60) === ctx);
          for (const x of sameGroup) groupNums.add(+x.number);
          const firstN = Math.min(...sameGroup.map(x => +x.number));
          const fh = heads.find(h => h.n === firstN);
          if (fh && fh.pg === head.pg) anchorHead = fh;
        }
        const prevHead = [...heads].reverse().find(h => h.pg === anchorHead.pg && h.y < anchorHead.y - 5);
        const searchTop = (anchorHead !== head && prevHead) ? prevHead.y : head.y;

        let box = null, mode = '';
        // 優先靠圖說定位：題幹寫「圖8」，PDF 裡就有一行「圖8」當圖說。
        // 只靠「這題的 y 範圍裡右邊有文字」會裁到選項與頁碼
        //（gsat 103 社會 #70 實測裁出「(D)卯」與「- 14 -」）。
        // 注意要分開抓「圖/表」與編號：ref[0] 是整段「圖8」，拿它去比 kind 永遠不相等
        const ref = new RegExp('([圖表])\\s*' + FIGNO).exec(String(q.question || ''));
        const refN = ref && figNum(ref[2]);
        const allCaps = capsOf(pages);
        const primary = refN && allCaps.find(c => c.kind === ref[1] && c.n === refN);

        /*
         * 一題常常引用好幾張圖：「圖10、圖11、表3」（gsat 107 社會 #64）、
         * 「甲圖…乙圖…」（gsat 107 國文 #24，選項在比較兩張圖）。
         * 只裁其中一張，使用者照樣答不出來，所以把**同一頁、題目有引用到**的
         * 圖說全部框進來。±400pt 是為了擋掉「同頁但屬於別題的同號圖說」。
         */
        const refsAll = [];
        {
          const txt = String(q.question || '') + ' ' + Object.values(q.options || {}).join(' ');
          const rx = new RegExp('([圖表])\\s*' + FIGNO, 'g');
          const seen = new Set();
          let m;
          while ((m = rx.exec(txt))) {
            const nn = figNum(m[2]);
            if (!nn || seen.has(m[1] + nn)) continue;
            seen.add(m[1] + nn);
            refsAll.push({ kind: m[1], n: nn });
          }
        }
        // 「甲圖」「乙圖」這種不帶編號的分圖，只用來判斷「這題需要不只一張圖」
        const panelRefs = new Set((String(q.question || '')
          + Object.values(q.options || {}).join('')).match(/[甲乙丙丁戊己庚]圖/g) || []).size;
        const multiFig = refsAll.length + panelRefs >= 2;

        const addBox = (b, m) => {
          if (!box) { box = b; mode = m; return; }
          if (box.page !== b.page) return;
          const bottom = Math.max(box.top + box.height, b.top + b.height);
          box.top = Math.min(box.top, b.top);
          box.left = Math.min(box.left, b.left);
          box.height = bottom - box.top;
          // 右界只要有一塊沒界線，合起來就沒有界線（裁到頁緣）
          box.right = (box.right != null && b.right != null) ? Math.max(box.right, b.right) : null;
          if (m !== mode) mode = '多圖合框';
        };

        const capList = primary
          ? allCaps.filter(c => c.pg === primary.pg && Math.abs(c.y - primary.y) <= 400
            && refsAll.some(r => r.kind === c.kind && r.n === c.n))
          : [];
        for (const cap of capList) {
          const pls = pages[cap.pg];
          // 從圖說往上走，跳過圖裡的短標籤，遇到正文行就停
          // 圖與選項並排時，往上找「正文」只能看**圖說那一欄**。
          // 看左欄會停在正上方的選項行「(D) 磁場B 對線圈的磁作用力」，
          // 框只剩一條、裁出來只有圖的下緣（ast 111 物理 #5 實測）。
          const sideBySide = cap.x >= SPLIT_X;
          const colMin = sideBySide ? SPLIT_X - 40 : 0;
          // 中文排版慣例：**圖的標題在下、表的標題在上**。
          // 一律往上找會讓所有表格題算出很窄的框而被丟掉
          //（ast 113 歷史 #17 的「表1」在 y=466，表身在它下面）。
          if (cap.kind === '表') {
            let bot = Infinity;
            /*
             * 「遇到第一條長行就收」會收在**表格自己的欄位標題**上。
             * gsat 101 社會 表五 的標題列「夏（6-8 月）秋（9-11 月）」有 17 字，
             * bot 於是停在圖說下方 14pt、整張表只剩一條，高度不足 50 被丟掉
             * （101/102/105 社會、111 分科公民整批都是這樣掉的）。
             * 要停的是**正文**，不是表格的列：正文貼左邊界，或帶選項／題號標籤；
             * 表格的儲存格再長也縮排在欄位裡。
             */
            const prose = l => {
              const t = l.t.trim();
              // 標籤要先認。選項行「(B)甲丙丁」只有 5 個字，先比長度就被當成表格的列，
              // 整排選項會被裁進表裡（分科 111 地理 #8 實測）。
              if (/^\(?[A-E][).]/.test(t)) return true;
              // 題號要寫成「點後面不是數字」。少了這個，表格裡的「2.79」「46.67」
              // 會被當成題號 2.／46.，bot 停在第一列數字上，整張表只剩標題列。
              if (/^\d{1,3}\s*[.．](?!\d)/.test(t)) return true;
              return t.length > 15 && l.x < 150;
            };
            for (const l of pls) {
              if (l.y <= cap.y + (cap.h || 12)) continue;
              if (l.x + (l.w || 0) <= cap.x) continue;        // 沒擋在表的正下方
              if (prose(l)) { bot = l.y - 4; break; }
            }
            // 下一個圖說＝下一張圖表，表身不可能跨過去
            for (const c2 of allCaps) {
              if (c2.pg === cap.pg && c2.y > cap.y + 20 && c2.y - 4 < bot) bot = c2.y - 4;
            }
            if (nextHead && nextHead.pg === cap.pg) bot = Math.min(bot, nextHead.y - 4);
            if (bot === Infinity) bot = cap.y + 320;
            // 左界：先看這一帶有沒有貼著左邊界的題幹／選項，有就從它們的右緣起算。
            // 只用 x >= colMin 會把表格最左邊的列標籤欄切掉（甲國乙國不見）；
            // 只用「表格內短行的最小 x」又會把選項一起框進來（選項也是短行）。
            const band = pls.filter(l => l.y >= cap.y && l.y <= bot);
            // 「貼左邊界」還不足以判定是題幹／選項 —— 表格最左邊那一欄的列標籤
            // （「稅前」「低所得」）也貼左邊界，一起算進去就會把整個列標籤欄切掉，
            // 裁出一張只剩數字、看不出是誰的表（分科 114 公民 #24 的表2 實測）。
            // 只有**長行**或**選項標籤**才是真的題幹／選項。
            const leftText = band.filter(l => l.x < 150
              && (l.t.trim().length > 20 || /^\(?[A-E][).]/.test(l.t.trim())));
            // 沒有題幹／選項擋路時就整段都是表，左界取「表內所有行的最左緣」，
            // 不能再退回 x>=150 的欄位起點，否則列標籤欄一樣會被切掉。
            /*
             * 表排在右欄時（圖說 x ≥ 分欄線），左欄整段都是情境文字，
             * 一行也不會超過 20 字（直排窄欄，一行 17~18 字），leftText 因此是空的，
             * 左界就退到 min(band.x) = 情境文字的 x，整段文字被裁進表裡
             * （gsat 102 社會 #62/#63 實測）。右欄的表要用**左欄文字的右緣**當左界。
             */
            const leftCol = band.filter(l => l.x < 150);
            const lf = sideBySide
              ? Math.max(colMin, leftCol.length
                ? Math.max(...leftCol.map(l => l.x + (l.w || 0))) + 8 : colMin)
              : (leftText.length
                ? Math.max(...leftText.map(l => l.x + (l.w || 0))) + 8
                : (band.length ? Math.max(0, Math.min(cap.x, ...band.map(l => l.x)) - 12) : colMin));
            const hh = bot - cap.y + 6;
            if (hh >= 50) addBox({ left: lf, top: cap.y - 6, height: hh, page: cap.pg }, '表說定位');
          } else {
          /*
           * 圖說正上方剛好有嵌入圖片區塊、而且水平涵蓋圖說中心 → 那就是這張圖的本體，
           * 直接用它的 bbox，不要再從文字行往上推。
           * 分科 111 公民的「資訊卡」整張圖就是一段說明文字，往上走的那套會停在
           * 卡片**裡面**的字上，框只剩 46pt 高而被丟掉（#21~#25 五題）。
           * 右界也要跟著圖塊收 —— 兩張卡片並排，不收就把隔壁的圖2 一起裁進來。
           */
          const capCx0 = cap.x + (cap.w || 0) / 2;
          const blks = figBlocks.filter(g => g.pg === cap.pg
            && g.y + g.h <= cap.y + 6 && g.y >= cap.y - 420
            && g.x - 8 <= capCx0 && g.x + g.w + 8 >= capCx0);
          // 只拿它的**上緣**。左右界還是交給下面的文字路 —— 圖常常是
          // 「圖片＋說明文字」的組合，光用圖塊的 bbox 會把旁邊的字切掉
          //（分科 115 公民 #9 的貼文圖實測裁成半張）。
          const blkTop = blks.length ? Math.min(...blks.map(g => g.y)) - 6 : null;
          // 從圖說往上走，遇到正文行就停。
          // 這行有沒有「擋在圖的正上方」：看它的右緣有沒有越過**圖說的 x**。
          // 用固定分欄線會出事——選項「(D) 磁場B 對線圈的磁作用力：甲＞乙」的右緣
          // 剛好越過分欄線，於是 top 停在選項那一行，圖被切掉上半張（ast 111 物理 #5）。
          // 用圖說的 x 就只會停在真正跨到圖上方的題幹長行。
          //
          // minX 是「這一行要從哪裡開始才算擋路」。第一趟不設限（0），
          // 第二趟用第一趟推出來的圖左緣 —— 見下面 walkUp 的兩趟說明。
          // 頁眉（第5頁／115年分科／地理考科／請記得在答題卷簽名…）不管在哪一欄
          // 都算擋路，否則整頁都沒有別的題號時會從頁首開始裁，把頁眉一起框進去。
          const HEADER = /^第\s*\d+\s*頁|^共\s*\d+\s*頁|考科\s*$|答題卷|請記得在|^\d{2,3}年(學測|分科|指考)/;
          const walkUp = minX => {
            for (let i = pls.length - 1; i >= 0; i--) {
              const l = pls[i];
              if (l.y >= cap.y) continue;
              if (HEADER.test(l.t.trim())) return l.y + (l.h || 12) + 4;
              if (l.x + (l.w || 0) <= cap.x) continue;
              if (l.x < minX) continue;
              if (l.t.trim().length > 15) return l.y + (l.h || 12) + 4;
            }
            return 0;
          };
          /*
           * 兩趟：圖與題幹**並排**時，題幹是從左邊界一路寫到圖說右邊的長行，
           * 第一趟會把它當成「擋在圖上方」，top 於是停在圖的半腰
           * —— 分科 115 地理 #22 的發電比例圖只裁到燃煤／燃氣，
           *    題目要問的核能與再生能源整段不見了。
           * 所以第二趟只認「從圖自己那一欄開始」的行，貼左邊界的題幹不算擋路。
           */
          let top = walkUp(0);
          {
            const probe = pls.filter(l => l.y >= top && l.y <= cap.y + (cap.h || 12) && l.x >= colMin);
            const figLeft = probe.length ? Math.min(cap.x, ...probe.map(l => l.x)) : cap.x;
            const t2 = walkUp(figLeft - 20);
            if (t2 < top) top = t2;
          }
          // 圖不可能排在題目之前：圖說與題號在同一頁時，用題號的位置當上界。
          // 右欄常常整欄都沒有「正文」行，top 會一路退到上一題去，把題幹一起裁進來。
          //
          // ⚠️ 例外：**圖說排在本題題號的上方**，代表圖在題幹之前
          //（題組的情境段就是這樣：分科 114 地理 #9 題號在 y402、圖3 的圖說在 y382）。
          // 這時拿 head.y 當上界會把 top 壓到圖說下面，算出來的高度只有 2，直接作廢
          // —— 分科那 50 題「題幹指名的圖說找不到」整批都是這樣掉的。
          // 上界要退到「圖說之前最近的那個題號」，而不是本題的題號。
          //
          // 退的時候要**跳過同一題組的題號**。分科 115 地理 #22 的圖4 排在
          // #21 的選項右邊，圖身一路往上到情境段；拿 #21 當下界就只裁到燃煤、
          // 燃氣兩段，題目要問的核能與再生能源整個不見。
          let upper = searchTop;
          if (cap.pg === head.pg && cap.y < head.y) {
            const before = [...heads].reverse().find(h => h.pg === cap.pg && h.y < cap.y - 5 && !groupNums.has(h.n));
            upper = before ? before.y : 0;
          } else if (cap.pg === head.pg) {
            const before = [...heads].reverse().find(h => h.pg === cap.pg && h.y < cap.y - 5 && !groupNums.has(h.n));
            if (before && before.y < upper) upper = before.y;
          }
          if (cap.pg === head.pg) top = Math.max(top, upper - 4);
          // 圖說正上方有嵌入圖片時，上緣以圖塊為準。往上走文字行那套會停在
          // 圖**裡面**的說明文字上（分科 111 公民的資訊卡整張都是字，
          // 框只剩 46pt 被丟掉）。圖塊不會低於 upper，所以照樣不會吃到上一題。
          if (blkTop != null) {
            const floor = cap.pg === head.pg ? upper - 4 : 0;
            const t2 = Math.max(blkTop, floor);
            if (t2 < top) top = t2;
          }
          const inFig = pls.filter(l => l.y >= top && l.y <= cap.y + (cap.h || 12) && l.x >= colMin);
          /*
           * ⚠️ left 不能只看「圖內文字的最左緣」。圖若沒有左側標籤
           *    （史料照片、地圖這種純影像），inFig 只剩圖說本身或右側的標註，
           *    left 就會跑到圖的中間，裁出一條窄長條
           *    —— gsat 111 社會 #38 裁成 194x206，整張史料圖只剩右邊一條。
           *
           *    圖說通常是置中對齊的，所以用「圖說中心往左鏡射」當保底下界：
           *    左緣至少要到 capCenter - (右緣 - capCenter)，再留一點邊。
           */
          const capCx = cap.x + (cap.w || 0) / 2;
          const figRight = inFig.length
            ? Math.max(cap.x + (cap.w || 0), ...inFig.map(l => l.x + (l.w || 0)))
            : cap.x + (cap.w || 0);
          const mirrored = capCx - (figRight - capCx);
          const byText = inFig.length ? Math.min(...inFig.map(l => l.x)) - 12 : colMin;
          // 純影像的圖（史料照片、地圖）在 inFig 裡只剩圖說自己，鏡射推不出寬度，
          // 這時要退到欄位起點，否則會裁成窄長條（gsat 111 社會 #38 的史料圖）。
          const left = Math.max(0, Math.min(byText, mirrored - 12, colMin));
          const h = cap.y + (cap.h || 12) + 6 - top;
          // 圖說正上方就是正文時會算出很窄的框（圖其實在更上面或跨欄）。
          // 這種情況不要硬裁，讓它退回下面兩種模式。
          if (h >= 50) addBox({ left, top, height: h, page: cap.pg }, '圖說定位');
          else if (blks.length) {
            // 文字路算不出框（圖說正上方就是正文）但下方確實有圖塊 —— 直接用圖塊的
            // bbox。這是最後一條，所以右界也收（gsat 104 自然 #63 的凌日光變曲線）。
            const bt = Math.min(...blks.map(g => g.y)) - 6;
            const h2 = cap.y + (cap.h || 12) + 6 - bt;
            if (h2 >= 50) addBox({
              left: Math.max(0, Math.min(...blks.map(g => g.x)) - 6), top: bt, height: h2,
              page: cap.pg, right: Math.max(...blks.map(g => g.x + g.w), cap.x + (cap.w || 0)) + 6,
            }, '圖塊定位');
          }
          }
        }
        /*
         * 圖說找不到時的第二條路：**原卷真的有一塊嵌入圖片，而且就落在這一題自己的範圍內**。
         *
         * 下面關掉的那兩條退路是「這題 y 範圍裡右欄有東西就裁」，會掛到隔壁題的圖。
         * 這條不一樣，它要求的是圖片區塊本身的 bbox，而且四個條件全部成立才用：
         *   1. 這題範圍內**只有一塊**圖（兩塊以上分不清哪塊是這題的）
         *   2. 那塊圖的上下範圍內**沒有別題的題號**（跨題號的是題組共用圖或隔壁題的）
         *   3. 題幹有指名「圖N」時，圖的正下方若有圖說，編號必須相符
         *      （編號對不上就是隔壁題的圖 —— 正是 ast 114 地理 #21 那種錯誤）
         *   4. 題幹沒指名編號時，圖的正下方也不能有別的圖說編號
         */
        if (!box) {
          // searchTop 已在上面算好（題組會延伸到前一個題號，一般題就是本題題號）
          const onPage = figBlocks.filter(g => g.pg === head.pg);
          const inQ = onPage.filter(g => g.y >= searchTop - 2
            && g.y + g.h <= (yBot === Infinity ? 1e9 : yBot) + 2);
          if (!onPage.length) bumpFig('該頁沒有嵌入圖片區塊');
          else if (!inQ.length) bumpFig('有圖但不在這題的 y 範圍內');
          else if (inQ.length > 1) bumpFig(`這題範圍內有 ${inQ.length} 塊圖，分不清`);
          // 這條路一次只能認一塊圖。題目要比較好幾張（「甲圖…乙圖…」）時，
          // 掛上其中一塊等於給使用者半張圖 —— gsat 107 國文 #24 實測只裁到「乙」那格，
          // 選項卻在問甲圖與乙圖的差別。寧可不補。
          const soloOk = !(multiFig && inQ.length === 1);
          if (!soloOk) bumpFig('題目要好幾張圖，只找到一塊');
          if (soloOk && inQ.length === 1) {
            const g = inQ[0];
            const spans = heads.some(h => h.pg === g.pg && h.n !== n && h.y > g.y && h.y < g.y + g.h);
            // 圖的正下方 24pt 內的圖說
            const near = capsOf(pages).filter(c => c.pg === g.pg
              && c.y >= g.y + g.h - 6 && c.y <= g.y + g.h + 24
              && c.x + 40 >= g.x && c.x <= g.x + g.w + 40);
            const clash = refN ? !near.some(c => c.kind === ref[1] && c.n === refN)
                               : near.length > 0;
            if (spans) bumpFig('圖的範圍跨到別題的題號（題組共用或隔壁題的）');
            else if (near.length && clash) bumpFig('圖說編號與題幹指名的對不上');
            else {
              box = { left: Math.max(0, g.x - 6), top: Math.max(0, g.y - 6), height: g.h + 12, page: g.pg };
              mode = '嵌入圖片';
            }
          }
        }
        // ⚠️ 沒有圖說就不要補。
        // 「裁這題 y 範圍裡右欄的東西」看似合理，實測是把**隔壁題的圖**掛上來：
        //   ast 114 地理 #21 問「表1」→ 裁出一張世界地圖
        //   gsat 104 自然 #8 問「哪種容器」→ 裁出別題的「圖2」流程圖
        // 錯的圖比沒有圖更糟（使用者會照著錯圖作答），所以這兩種退路都關掉，
        // 只留最可靠的圖說定位。程式碼保留是為了記著「試過、不行」。
        if (!box) {
          if (process.env.CEEC_DEBUG) {
            const cs = capsOf(pages).filter(c => c.kind === (ref && ref[1]) && c.n === refN)
            console.log(`  × ${exam} ${year} ${tag} #${n}  指名 ${ref ? ref[1] + refN : '（沒指名）'}` +
              `  題號 p${head.pg} y${Math.round(head.y)}  searchTop ${Math.round(searchTop)}` +
              `  同號圖說 ${cs.map(c => `p${c.pg} x${Math.round(c.x)} y${Math.round(c.y)}`).join(' / ') || '無'}` +
              `  ${ctx ? '題組' : ''}`)
          }
          bump(refN ? '題幹指名的圖說找不到' : '沒有圖說可定位'); continue;
        }
        if (false && rightLines.length >= 2) {
          // 圖在右欄：裁右半邊，y 取該題範圍
          const top = Math.min(...rightLines.map(l => l.y));
          const bot = Math.max(...rightLines.map(l => l.y + (l.h || 10)));
          // 左界：盡量往左，但不能碰到左欄的文字。
          // 「左欄文字」只算**與圖同一水平帶**的那幾行——題幹在圖上方、排得再寬也不影響圖的左界。
          // 取整題的左欄最大右緣會把左界推得太右，圖的左半就被切掉（gsat 100 社會 #6 的長條圖實測）；
          // 反過來完全不看又會把題幹尾巴裁進來（gsat 100 自然 #5 的「個族群」？」）。
          const rightMinX = Math.min(...rightLines.map(l => l.x));
          const leftTextMax = Math.max(0, ...inRange
            .filter(l => l.x < SPLIT_X && l.y + (l.h || 10) > top - 6 && l.y < bot + 6)
            .map(l => l.x + (l.w || 0)));
          box = { left: Math.max(0, Math.min(rightMinX - 15, leftTextMax + 8)), top: top - 10, height: bot - top + 20 };
          mode = '右欄';
        }
        if (!box) {
          // 圖在題幹下方：找「題幹與第一個選項之間」沒有文字行的空白帶
          const firstOpt = inRange.find(l => /^\(?[A-E][).]/.test(l.t.trim()));
          if (!firstOpt) { bump('找不到第一個選項'); continue; }
          const between = inRange.filter(l => l.y > head.y && l.y < firstOpt.y);
          let band = null, prev = head.y + (head.h || 12);
          for (const l of between) {
            if (l.y - prev >= 35 && (!band || l.y - prev > band.h)) band = { top: prev, h: l.y - prev };
            prev = Math.max(prev, l.y + (l.h || 12));
          }
          if (firstOpt.y - prev >= 35 && (!band || firstOpt.y - prev > band.h)) band = { top: prev, h: firstOpt.y - prev };
          if (!band) { bump('題幹與選項間沒有空白帶'); continue; }
          box = { left: 0, top: band.top - 4, height: band.h + 8 };
          mode = '題幹下方';
        }

        // 檔名用科目 tag 不用中文科目名：圖片路徑會直接進 URL，
        // 中文檔名得靠瀏覽器／CDN 編碼一致才不會 404，沒必要冒這個險。
        const name = `${exam}_${year}_${tag}_q${n}_fig.webp`;
        if (!APPLY) { stats.made++; continue; }
        try {
          const page = doc.loadPage(box.page != null ? box.page : head.pg);
          const pm = page.toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceRGB, false, true);
          const png = Buffer.from(pm.asPNG());
          const meta = await sharp(png).metadata();
          const left = Math.max(0, Math.round(box.left * SCALE));
          const top = Math.max(0, Math.round(box.top * SCALE));
          const height = Math.min(meta.height - top, Math.round(box.height * SCALE));
          const width = (box.right != null
            ? Math.min(meta.width, Math.round(box.right * SCALE)) : meta.width) - left;
          if (height < 60 || width < 60) { bump('裁出來太小'); continue; }
          const base = await sharp(png).extract({ left, top, width, height }).png().toBuffer();
          // 近乎全白就代表原卷那裡根本沒有圖；直接 .trim() 會拋 extract_area 例外
          const s2 = await sharp(base).stats();
          if (!s2.channels.some(c => c.min < 200)) { bump('該區塊是空白(原卷沒圖)'); continue; }
          let outBuf;
          try { outBuf = await sharp(base).trim({ threshold: 12 }).toBuffer(); }
          catch (_) { outBuf = base; }
          // 去白邊之後才知道真正的圖有多大。太扁的多半是只裁到圖的一條窄帶
          //（gsat 102 自然 #16 是器材圖下緣 314x42、ast 114 地理 #42 是地圖上緣 504x80），
          // 那種圖放出去反而誤導，寧可不放。
          const fin = await sharp(outBuf).metadata();
          if (fin.width < 150 || fin.height < 110) { bump('成品尺寸過小(只裁到邊緣)'); continue; }
          await sharp(outBuf).webp({ quality: 88 }).toFile(path.join(IMG, name));
          q.images = [`/question-images/${name}`];
          q.image_mode = mode;
          touched = true;
          stats.made++;
        } catch (e) { bump('裁圖失敗: ' + String(e.message).slice(0, 30)); }
      }
    }
    if (APPLY && touched) fs.writeFileSync(p, JSON.stringify(raw, null, 2), 'utf8');
  }

  console.log(`${APPLY ? '已產生' : '可產生'} ${stats.made} 張圖｜跳過 ${stats.skip}`);
  if (Object.keys(why).length) console.log('跳過原因:', JSON.stringify(why, null, 1));
  if (stats.figWhy && Object.keys(stats.figWhy).length) console.log('【嵌入圖片】這條路沒走成的原因:', JSON.stringify(stats.figWhy, null, 1));
})().catch(e => { console.error(e.stack); process.exit(1); });
