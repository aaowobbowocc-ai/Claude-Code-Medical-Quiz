#!/usr/bin/env node
/**
 * 拿「整場次清冊」裡的**整卷標準答案**比對題庫答案。
 *
 * 跟 audit-answers-sitewide.js 的差別：那一支一卷抓一份答案卷（要先解出
 * c=類科/s=科目 才抓得到），所以非醫事類的考試（鐵路、警察共同科目…）很多對不到；
 * 這一支走 t=A 的整場清冊 —— 一個場次一份 PDF，裡面每個科目都印了整卷答案，
 * 不需要 c/s。鐵路特考 100-112 共 104 卷就是這樣才驗得到的
 * （audit-answers-sitewide.js 把 railway-* 放在 SKIP 裡當成「非考選部來源」，
 *  其實鐵路特考跟警察特考是同一個場次合辦，清冊裡有）。
 *
 * 可信範圍：清冊的答案表格只有前 60 題的配法是確定的，複選卷只到單選段為止，
 * 詳見 fetch-session-corrections.js 的註解。這一支只比 trustMax 以內的題。
 *
 *   node scripts/audit-session-answers.js [--exam=railway-admin] [--apply] [--min=0.95]
 */
const fs = require('fs');
const path = require('path');
const { nameCandidates } = require('./lib/moex-paper-resolve');
const { sessionSheet, parseSheet } = require('./fetch-session-corrections');

const BK = path.join(__dirname, '..');
const OUT = path.join(BK, '_tmp', 'session-answer-audit.json');
const APPLY = process.argv.includes('--apply');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const onlyExam = arg('exam');
const MIN = +(arg('min') || 0.95);
/*
 * --skip-file：一份 ["exam|code|subject|題號", …]，這些題不要照清冊改。
 * 用途是擋掉「選項順序本來就跟原卷不符」的題 —— 那種題的答案字母本來就沒有意義，
 * 照清冊改只會把錯的地方從答案搬到選項。清單用 audit-options-vs-paper.js --json 產生。
 */
const SKIP = new Set(arg('skip-file') ? JSON.parse(fs.readFileSync(arg('skip-file'), 'utf8')) : []);
const fileOf = e => (e === 'doctor1' ? 'questions.json' : `questions-${e}.json`);

/**
 * 我們的考試 id → 清冊上的（等級名稱, 類科名稱）。
 *
 * 等級一定要篩：警察三等與四等的「國文」是不同的卷，鐵路佐級與員級也是。
 * 類科要用「包含」比而不是 `^` 比：共同科目那幾列的類科名稱是一長串
 *   事務管理、機械工程、機檢工程、電力工程、電子工程、養路工程
 * 而且會被印到一半就截斷（107070 行政警察人員、…、警察）。
 */
const MATCH = {
  // 醫事類：類科名稱就是一個名字，沒有等級之分（都是高考）
  doctor1: { klass: /^醫師[（(]一/ }, doctor2: { klass: /^醫師[（(]二/ },
  dental1: { klass: /^牙醫師[（(]一/ }, dental2: { klass: /^牙醫師[（(]二/ },
  pharma1: { klass: /^藥師[（(]一/ }, pharma2: { klass: /^藥師[（(]二/ },
  tcm1: { klass: /^中醫師[（(]一/ }, tcm2: { klass: /^中醫師[（(]二|^中醫師$/ },
  nursing: { klass: /^護理師/ }, nutrition: { klass: /^營養師/ }, medlab: { klass: /^醫事檢驗師/ },
  radiology: { klass: /^醫事放射師/ }, pt: { klass: /^物理治療師/ }, ot: { klass: /^職能治療師/ },
  rt: { klass: /^呼吸治療師/ }, vet: { klass: /^獸醫師/ }, audiologist: { klass: /^聽力師/ },
  'speech-therapist': { klass: /^語言治療師/ }, 'clinical-psychology': { klass: /^臨床心理師/ },
  'counseling-psychology': { klass: /^諮商心理師/ }, 'social-worker': { klass: /^社會工作師/ },
  'dental-tech': { klass: /^牙體技術師/ }, optometrist: { klass: /^驗光師/ },
  'optometrist-junior': { klass: /^驗光生/ }, 'public-health': { klass: /^公共衛生師/ },
  // 公職／特考類：要連等級一起篩
  lawyer1: { klass: /^(司法官|律師|司法官及律師)/ },
  police: { level: /三等/, klass: /警察|公共安全|國家安全|消防|水上警察|刑事|交通警察|國境|犯罪防治|外事/ },
  police4: { level: /四等/, klass: /警察|公共安全|消防|水上警察|刑事|交通警察|國境|犯罪防治|外事/ },
  customs: { klass: /關稅|關務|財稅行政|一般行政/ },
  'railway-admin': { level: /佐級/, klass: /^事務管理$/ },
  'railway-transport': { level: /佐級/, klass: /^運輸營業$/ },
};

const pieces = s => String(s || '').split(/[、,，]/).map(x => x.trim()).filter(Boolean);
const hitKlass = (re, rec) => !re || re.test(rec.klass) || pieces(rec.klassFull).some(p => re.test(p));

(async () => {
  const files = {};
  const load = e => files[e] || (files[e] = JSON.parse(fs.readFileSync(path.join(BK, fileOf(e)), 'utf8')));
  const rows = e => { const j = load(e); return Array.isArray(j) ? j : j.questions; };

  const exams = Object.keys(MATCH).filter(e => (!onlyExam || e === onlyExam) && fs.existsSync(path.join(BK, fileOf(e))));
  const sheets = {};
  const report = [];
  const touched = new Set();
  let fixed = 0;

  for (const exam of exams) {
    const papers = {};
    for (const q of rows(exam)) {
      if (!/^\d{6}$/.test(String(q.exam_code || '')) || !q.subject) continue;
      (papers[`${q.exam_code}|${q.subject}`] = papers[`${q.exam_code}|${q.subject}`] || []).push(q);
    }
    for (const key of Object.keys(papers).sort()) {
      const [code, subject] = key.split('|');
      if (!(code in sheets)) {
        const txt = await sessionSheet(code);
        sheets[code] = txt ? parseSheet(txt) : null;
      }
      if (!sheets[code]) { report.push({ exam, code, subject, status: '無清冊' }); continue; }
      const qs = papers[key];
      const maxN = Math.max(...qs.map(x => +x.number || 0));
      /*
       * 類科只能當提示，不能當閘門。合辦場次（警察＋鐵路＋一般警察）的 PDF
       * 文字順序會把類科與科目的對應打散，實測 108070 的「事務管理大意」掛在
       * 「材料管理」底下、「水上警察情境實務概要」掛在「事務管理」底下。
       * 所以先用科目名稱＋題數篩，類科只在還有多個候選時用來打破平手。
       */
      const pool = sheets[code].filter(r => r.keyOk);
      if (!pool.length) { report.push({ exam, code, subject, status: '清冊沒有可用的答案' }); continue; }
      let { list } = nameCandidates(exam, subject, pool);
      if (!list.length) { report.push({ exam, code, subject, status: '科目名稱對不到' }); continue; }
      /*
       * 題數要對得上，對不上就放棄 —— 不能退回未過濾的清單。
       * 鐵路佐級的「國文(包括公文格式用語)」是 45 題全測驗，警察佐級的
       * 「國文（作文、公文與測驗）」只有 10 題測驗（作文公文是申論），
       * 兩者在清冊上是同一個類科清單底下的兩筆；少了這個關卡就會拿
       * 10 題那一卷的答案去對 50 題這一卷，對齊率 30%。
       */
      const sized = list.filter(r => Math.abs(r.count - maxN) <= 2 || Math.abs(r.singles - maxN) <= 2);
      if (!sized.length) {
        report.push({ exam, code, subject, status: '題數對不上', maxN,
          cand: list.map(r => `${r.subject}=${r.count}題`).join('、') });
        continue;
      }
      list = sized;
      // 平手時才用類科打破
      if (list.length > 1) {
        const byKlass = list.filter(r => hitKlass(MATCH[exam].klass, r));
        if (byKlass.length) list = byKlass;
      }

      // 候選裡挑對齊率最高的；對齊率本身就是「是不是同一卷」的證據
      let best = null, second = null;
      for (const r of list) {
        let hit = 0, tot = 0; const bad = [];
        for (const q of qs) {
          const n = +q.number;
          if (!(n >= 1 && n <= r.trustMax)) continue;
          const a = r.answers[n];
          if (!a || a === '#') continue;
          const mine = String(q.answer || '').trim().toUpperCase();
          if (!/^[A-E]$/.test(mine)) continue;   // 送分、多答案不比
          tot++;
          if (mine === a) hit++; else bad.push({ n, mine, want: a, id: q.id });
        }
        if (!tot) continue;
        const cand = { rate: hit / tot, tot, bad, r };
        if (!best || cand.rate > best.rate) { second = best; best = cand; }
        else if (!second || cand.rate > second.rate) second = cand;
      }
      if (!best) { report.push({ exam, code, subject, status: '沒有可比的題' }); continue; }
      /*
       * 兩個候選都對得起來就不要賭。清冊的「等級名稱」在合辦場次不可靠
       * （鐵路佐級那一列印的是「三等考試」），所以分不出三等/四等的同名共同科目時，
       * 只能靠對齊率；兩個都高就是同一卷（改哪個都一樣），兩個都中等才是真歧義。
       */
      const ambiguous = second && second.rate >= 0.5 && best.rate < MIN;
      const row = {
        exam, code, subject, maxN, rate: +best.rate.toFixed(4), compared: best.tot,
        sheet: `${best.r.level}/${best.r.klassFull.slice(0, 30)}/${best.r.subject}`,
        count: best.r.count, trustMax: best.r.trustMax, diff: best.bad,
        status: ambiguous ? '多筆候選' : best.rate >= MIN ? '可修' : best.rate >= 0.5 ? '待人工確認' : '疑似配錯',
      };
      report.push(row);

      // 要寫入就連題數都要完全相符，±2 的放寬只拿來篩候選
      if (APPLY && row.status === '可修' && best.bad.length && (best.r.count === maxN || best.r.singles === maxN)) {
        for (const d of best.bad) {
          if (SKIP.has(`${exam}|${code}|${subject}|${d.n}`)) continue;
          const q = qs.find(x => +x.number === d.n);
          if (!q) continue;
          if (q.original_answer === undefined) q.original_answer = q.answer;
          q.answer = d.want;
          fixed++;
        }
        touched.add(exam);
      }
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1), 'utf8');

  const by = s => report.filter(r => r.status === s);
  const ok = report.filter(r => r.rate >= MIN);
  console.log(`比對 ${report.length} 卷：對齊 ≥${MIN * 100}% ${ok.length} 卷｜待人工確認 ${by('待人工確認').length}｜疑似配錯 ${by('疑似配錯').length}`);
  console.log(`對不到：無清冊 ${by('無清冊').length}｜沒這個等級/類科 ${by('清冊沒有這個等級/類科').length}｜科目名稱 ${by('科目名稱對不到').length}`);
  const nDiff = ok.reduce((a, r) => a + r.diff.length, 0);
  console.log(`對齊的卷裡還有 ${nDiff} 題答案與清冊不同`);
  for (const r of ok) if (r.diff.length) {
    console.log(`  ${r.exam} ${r.code} ${r.subject}  ${(r.rate * 100).toFixed(0)}% (${r.compared}題)  ${r.diff.map(d => `#${d.n} ${d.mine}→${d.want}`).join(' ')}`);
  }
  for (const r of by('待人工確認').concat(by('疑似配錯'))) {
    console.log(`  [${r.status}] ${r.exam} ${r.code} ${r.subject}  ${(r.rate * 100).toFixed(0)}% (${r.compared}題)  清冊=${r.sheet}`);
  }

  if (APPLY) {
    for (const e of touched) {
      fs.writeFileSync(path.join(BK, fileOf(e)), JSON.stringify(files[e], null, 2), 'utf8');
      console.log('寫入', fileOf(e));
    }
    console.log(`改了 ${fixed} 題答案`);
  } else {
    console.log(`報告：${path.relative(BK, OUT)}（試跑；加 --apply 才寫入）`);
  }
})();
