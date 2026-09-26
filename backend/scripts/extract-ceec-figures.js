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
  const re = new RegExp('^([圖表])\\s*' + FIGNO + '\\s*$');
  const out = [];
  pages.forEach((ls, pg) => ls.forEach(l => {
    const m = re.exec(l.t.trim());
    const n = m && figNum(m[2]);
    if (n) out.push({ pg, x: l.x, y: l.y, h: l.h, kind: m[1], n });
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

      // 逐頁收行
      const pages = [];
      for (let pg = 0; pg < doc.countPages(); pg++) {
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

        let box = null, mode = '';
        // 優先靠圖說定位：題幹寫「圖8」，PDF 裡就有一行「圖8」當圖說。
        // 只靠「這題的 y 範圍裡右邊有文字」會裁到選項與頁碼
        //（gsat 103 社會 #70 實測裁出「(D)卯」與「- 14 -」）。
        // 注意要分開抓「圖/表」與編號：ref[0] 是整段「圖8」，拿它去比 kind 永遠不相等
        const ref = new RegExp('([圖表])\\s*' + FIGNO).exec(String(q.question || ''));
        const refN = ref && figNum(ref[2]);
        const cap = refN && capsOf(pages).find(c => c.kind === ref[1] && c.n === refN);
        if (cap) {
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
            for (const l of pls) {
              if (l.y <= cap.y + (cap.h || 12)) continue;
              if (l.x + (l.w || 0) <= cap.x) continue;        // 沒擋在表的正下方
              if (l.t.trim().length > 15) { bot = l.y - 4; break; }
            }
            if (nextHead && nextHead.pg === cap.pg) bot = Math.min(bot, nextHead.y - 4);
            if (bot === Infinity) bot = cap.y + 320;
            // 左界：先看這一帶有沒有貼著左邊界的題幹／選項，有就從它們的右緣起算。
            // 只用 x >= colMin 會把表格最左邊的列標籤欄切掉（甲國乙國不見）；
            // 只用「表格內短行的最小 x」又會把選項一起框進來（選項也是短行）。
            const band = pls.filter(l => l.y >= cap.y && l.y <= bot);
            const leftText = band.filter(l => l.x < 150);
            const cells = band.filter(l => l.x >= 150 && l.t.trim().length <= 20);
            const lf = leftText.length
              ? Math.max(...leftText.map(l => l.x + (l.w || 0))) + 8
              : (cells.length ? Math.max(0, Math.min(...cells.map(l => l.x)) - 12) : colMin);
            const hh = bot - cap.y + 6;
            if (hh >= 50) { box = { left: lf, top: cap.y - 6, height: hh, page: cap.pg }; mode = '表說定位'; }
          } else {
          let top = 0;
          for (let i = pls.length - 1; i >= 0; i--) {
            const l = pls[i];
            if (l.y >= cap.y) continue;
            // 這行有沒有「擋在圖的正上方」：看它的右緣有沒有越過**圖說的 x**。
            // 用固定分欄線會出事——選項「(D) 磁場B 對線圈的磁作用力：甲＞乙」的右緣
            // 剛好越過分欄線，於是 top 停在選項那一行，圖被切掉上半張（ast 111 物理 #5）。
            // 用圖說的 x 就只會停在真正跨到圖上方的題幹長行。
            if (l.x + (l.w || 0) <= cap.x) continue;
            const isBody = l.t.trim().length > 15;
            if (isBody) { top = l.y + (l.h || 12) + 4; break; }
          }
          // 圖不可能排在題目之前：圖說與題號在同一頁時，用題號的位置當上界。
          // 右欄常常整欄都沒有「正文」行，top 會一路退到上一題去，把題幹一起裁進來。
          if (cap.pg === head.pg) top = Math.max(top, head.y - 4);
          const inFig = pls.filter(l => l.y >= top && l.y <= cap.y + (cap.h || 12) && l.x >= colMin);
          const left = inFig.length ? Math.max(0, Math.min(...inFig.map(l => l.x)) - 12) : 0;
          const h = cap.y + (cap.h || 12) + 6 - top;
          // 圖說正上方就是正文時會算出很窄的框（圖其實在更上面或跨欄）。
          // 這種情況不要硬裁，讓它退回下面兩種模式。
          if (h >= 50) { box = { left, top, height: h, page: cap.pg }; mode = '圖說定位'; }
          }
        }
        // ⚠️ 沒有圖說就不要補。
        // 「裁這題 y 範圍裡右欄的東西」看似合理，實測是把**隔壁題的圖**掛上來：
        //   ast 114 地理 #21 問「表1」→ 裁出一張世界地圖
        //   gsat 104 自然 #8 問「哪種容器」→ 裁出別題的「圖2」流程圖
        // 錯的圖比沒有圖更糟（使用者會照著錯圖作答），所以這兩種退路都關掉，
        // 只留最可靠的圖說定位。程式碼保留是為了記著「試過、不行」。
        if (!box) { bump(refN ? '題幹指名的圖說找不到' : '沒有圖說可定位'); continue; }
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
          const width = meta.width - left;
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
})().catch(e => { console.error(e.stack); process.exit(1); });
