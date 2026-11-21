#!/usr/bin/env node
/**
 * 拿「整場次更正清冊」比對全站答案（不是只比有 correction_note 的那些）。
 *
 * 清冊怎麼來：scripts/fetch-session-corrections.js（一個場次一份，t=A 不帶 c/s）。
 * 125 個場次、2,736 個科目，其中 918 個科目有更正紀錄 —— 而題庫裡
 * 只有 286 筆 correction_note，差距很大，所以要整批對。
 *
 * 配對方式：場次碼相同 → 先用**類科名稱**挑出我們這個考試的段落
 * （一個場次有五十幾個科目，不篩類科會對到別的考試同名的卷），
 * 再用 lib/moex-paper-resolve 的 nameCandidates 比科目名稱（四層放寬）。
 *
 *   node scripts/audit-session-corrections.js [--exam=pt] [--apply]
 */
const fs = require('fs');
const path = require('path');
const { nameCandidates } = require('./lib/moex-paper-resolve');
const { sessionSheet, parseSheet } = require('./fetch-session-corrections');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const onlyExam = arg('exam');
const fileOf = e => (e === 'doctor1' ? 'questions.json' : `questions-${e}.json`);

/** 我們的考試 id → 清冊上的類科名稱。括號有全形半形兩種寫法。 */
const KLASS = {
  doctor1: /^醫師[（(]一/, doctor2: /^醫師[（(]二/,
  dental1: /^牙醫師[（(]一/, dental2: /^牙醫師[（(]二/,
  pharma1: /^藥師[（(]一/, pharma2: /^藥師[（(]二/,
  tcm1: /^中醫師[（(]一/, tcm2: /^中醫師[（(]二|^中醫師$/,
  nursing: /^護理師/, nutrition: /^營養師/, medlab: /^醫事檢驗師/,
  radiology: /^醫事放射師/, pt: /^物理治療師/, ot: /^職能治療師/,
  rt: /^呼吸治療師/, vet: /^獸醫師/, audiologist: /^聽力師/,
  'speech-therapist': /^語言治療師/, 'clinical-psychology': /^臨床心理師/,
  'counseling-psychology': /^諮商心理師/, 'social-worker': /^社會工作師/,
  'dental-tech': /^牙體技術師/, optometrist: /^驗光師/, 'optometrist-junior': /^驗光生/,
  'public-health': /^公共衛生師/,
};

(async () => {
  const files = {};
  const load = e => files[e] || (files[e] = JSON.parse(fs.readFileSync(path.join(BK, fileOf(e)), 'utf8')));
  const rows = e => { const j = load(e); return Array.isArray(j) ? j : j.questions; };

  const exams = Object.keys(KLASS).filter(e => (!onlyExam || e === onlyExam) && fs.existsSync(path.join(BK, fileOf(e))));
  const sheets = {};
  const diff = [], missed = [], ambiguous = [];
  let matched = 0, checked = 0;
  const touched = new Set();

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
      const recs = sheets[code];
      if (!recs) continue;
      const mine = recs.filter(r => KLASS[exam].test(r.klass));
      if (!mine.length) { missed.push(`${exam} ${code} ${subject}  清冊沒有這個類科`); continue; }
      const maxN = Math.max(...papers[key].map(x => +x.number || 0));
      let { list } = nameCandidates(exam, subject, mine);
      if (!list.length) { missed.push(`${exam} ${code} ${subject}  科目名稱對不到`); continue; }
      if (list.length > 1) {
        /*
         * 對到好幾個要先收斂，收斂不了才放棄。兩種成因：
         * 1. **名稱比對是前綴比對**：社工師的「社會工作」會同時命中清冊上的
         *    「社會工作」「社會工作直接服務」「社會工作管理」。先挑**完全相同**的。
         * 2. **同一個場次有兩個類科開同名科目**：102110 同時有「中醫師」與
         *    「中醫師(二)」，中醫臨床醫學(一) 兩邊都有。挑**名稱比較長**的那個類科
         *    （分階段之後的正式類科名），bare 的是舊制殘留。
         * 都收斂不了才用題數挑。
         */
        const norm = x => String(x).replace(/\s/g, '').normalize('NFC');
        const exact = list.filter(r => norm(r.subject) === norm(subject));
        if (exact.length) list = exact;
        if (list.length > 1) {
          const longest = Math.max(...list.map(r => r.klass.length));
          const bySpecific = list.filter(r => r.klass.length === longest);
          if (bySpecific.length) list = bySpecific;
        }
        if (list.length > 1) {
          const byCount = list.filter(r => r.count && Math.abs(r.count - maxN) <= 2);
          if (byCount.length === 1) list = byCount;
        }
        // 候選的更正內容完全一樣時，挑哪一個都沒差（聽力師 102110 同一科出現兩次，
        // 科目代碼不同但兩邊備註都是空的）
        if (list.length > 1) {
          const same = new Set(list.map(r => JSON.stringify(r.corrections)));
          if (same.size === 1) list = [list[0]];
        }
      }
      if (list.length > 1) { ambiguous.push(`${exam} ${code} ${subject}  對到 ${list.length} 個科目（${list.map(r => r.klass + '/' + r.subject.slice(0, 12)).join('、')}）`); continue; }
      const rec = list[0];
      /*
       * 配對防呆：清冊上寫的題數要跟我們這一卷的題號上限對得起來。
       * 名稱比對有四層放寬，放寬到第 3、4 層時有機會對到同類科的別卷；
       * 一旦配錯，下面就會把**別卷的更正**套到這一卷的答案上。
       * 題數是清冊自己印的，拿來當獨立佐證最省事。
       */
      if (rec.count && Math.abs(rec.count - maxN) > 2) {
        missed.push(`${exam} ${code} ${subject}  題數對不上（清冊 ${rec.count} vs 題庫最大題號 ${maxN}）`);
        continue;
      }
      matched++;
      for (const [nStr, raw] of Object.entries(rec.corrections)) {
        checked++;
        const q = papers[key].find(x => +x.number === +nStr);
        if (!q) { missed.push(`${exam} ${code} ${subject} #${nStr}  清冊說要更正，題庫沒有這一題`); continue; }
        /*
         * 「答A、B、C、D給分」＝每個選項都給分，跟「一律給分」是同一件事。
         * 存成「送分」前端才會顯示「一律給分」，存 "A,B,C,D" 判對錯雖然一樣，
         * 檢討頁會印出「正確答案是 A,B,C,D」，看起來像是複選題。
         * ⚠️ 只有在**涵蓋這一題所有選項**時才換，五選一的卷不能用四個字母判定。
         */
        const opts = Object.keys(q.options || {});
        const want = (raw !== '送分' && opts.length && raw.split(',').length === opts.length
          && opts.every(k => raw.split(',').includes(k))) ? '送分' : raw;
        if (String(q.answer) === want) continue;
        diff.push(`${exam} ${code} ${subject} #${nStr}  ${q.answer} → ${want}`);
        if (APPLY) {
          if (!q.original_answer) q.original_answer = String(q.answer);
          q.answer = want;
          q.disputed = true;
          q.correction_note = `更正清冊：第${nStr}題 → ${want}`;
          touched.add(exam);
        }
      }
    }
  }
  console.log(`配對成功 ${matched} 卷｜清冊上的更正 ${checked} 題｜答案不符 ${diff.length} 題`);
  console.log(`對不到 ${missed.length}｜一個科目對到多筆 ${ambiguous.length}\n`);
  const CAP = process.argv.includes('--full') ? 1e9 : 40;
  diff.slice(0, CAP).forEach(s => console.log('   ' + s));
  if (diff.length > CAP) console.log(`   …還有 ${diff.length - CAP}`);
  if (missed.length) { console.log('\n--- 對不到 ---'); missed.slice(0, CAP).forEach(s => console.log('   ' + s)); }
  if (ambiguous.length) { console.log('\n--- 多筆候選 ---'); ambiguous.slice(0, CAP).forEach(s => console.log('   ' + s)); }
  if (APPLY) {
    for (const e of touched) fs.writeFileSync(path.join(BK, fileOf(e)), JSON.stringify(files[e], null, 2));
    console.log(`\n✅ 已寫入 ${[...touched].join(', ')}`);
  } else console.log('\n(試跑；加 --apply 才寫入)');
})();
