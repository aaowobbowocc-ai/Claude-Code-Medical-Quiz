#!/usr/bin/env node
/**
 * 學測／分科的最後一個選項常常把**後面整段東西**吃進去：
 *   D: "從森嚴的階級社會到平等社會 25-26 為題組 ◎ 近代早期，歐洲政治上…"
 *   D: "全球海洋浮油覆蓋面積是土耳其國土兩倍 70 60 50 40 30 2016 2018 2020 …"
 * 吃進去的是下一個題組的引文、圖表的座標軸文字、頁碼與「請記得在答題卷簽名」。
 * 使用者看到的最後一個選項會是一大段文章。
 *
 * 只在**明確標記**處切，切不到就整段留著——切壞好選項比少修還糟
 * （見 procedure_health_report_rules 的教訓）。
 *
 *   node scripts/repair-ceec-option-tail.js            # dry-run
 *   node scripts/repair-ceec-option-tail.js --apply
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./lib/atomic-write');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const FILES = ['questions-ast.json', 'questions-gsat.json'];

const JUNK = [
  /\s*請記得在答題卷簽名欄位/,
  // 題號中間可能夾空白（PDF 抽出來是 "7 1 - 7 2題為題組"）
  /\s*\d(?:\s*\d)*\s*[-－~～]\s*\d(?:\s*\d)*\s*題?\s*為題組/,
  /\s*\d{2,3}\s*年\s*(分科|學測)/,
  /\s*第\s*\d+\s*頁/,
  /\s*共\s*\d+\s*頁/,
  /\s*第\s*[壹貳參肆]\s*部分/,
  /\s*閱讀\s*[一二三四五六七八]\s/,
  /\s*[一二三四五六]\s*、\s*(單|多|複)選題/,
  /\s*說明\s*[：:︰]/,
  /\s*第\s*\d+\s*題至第\s*\d+\s*題/,
  /\s*◎/,
  // 圖號／照片號在尾巴才算殘渣，後面不能接「所示/中/的/之」
  /\s+(圖|表|照片)\s*[一二三四五六\d]+\s*(?![所中的之])/,
];

// ⚠️ 試過兩條「看形狀」的規則，兩條都把好選項切壞了，已移除：
//   「連續 4 組以上的數字當座標軸」→ 109 學測自然 #58 的
//      「1.0×10⁻⁶ M」被削掉，四個選項變成兩兩重複；
//      108 社會 #57 的「1707、1800 年的聯合法」也不見了。
//   「同一段重複出現就切」→ 106 國文 #13 的「孔乙己還欠十九個錢呢！」
//      原文就是講兩次；114 地理 #40 的「減去平日日間活動人數的欄位數值」也是。
// 圖表座標軸的文字就留著，宁可少修。

function clean(t) {
  let out = t;
  for (const re of JUNK) {
    const m = re.exec(out);
    if (m && m.index > 0) out = out.slice(0, m.index);
  }
  return out.trim();
}

const changes = [];
for (const f of FILES) {
  const p = path.join(BK, f);
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const arr = data.questions || data;
  let n = 0;
  for (const q of arr) {
    for (const k of Object.keys(q.options || {})) {
      const t = String(q.options[k] || '');
      if (t.length < 14) continue;                   // 太短的不動
      const c = clean(t);
      if (c === t) continue;
      // 不能要求切完一定要有幾個字：「耶穌會」「丁」本來就是完整選項，
      // 後面黏的是「二、多選題（占 12 分）」。只擋切成空字串。
      if (!c) continue;
      changes.push({ f, q, k, from: t, to: c });
      if (APPLY) q.options[k] = c;
      n++;
    }
  }
  console.log(`${f}: ${n} 個選項剪掉尾巴`);
  if (APPLY && n) atomicWriteJson(p, data);
}

changes.sort((a, b) => a.to.length - b.to.length);
console.log('\n切完最短的 6 個（最可能切壞，要看）：');
for (const c of changes.slice(0, 6)) {
  console.log(`  ${c.q.roc_year} ${c.q.subject} #${c.q.number} ${c.k}  ${c.from.length}→${c.to.length} 字`);
  console.log(`    留: ${JSON.stringify(c.to)}`);
  console.log(`    切: ${JSON.stringify(c.from.slice(c.to.length).slice(0, 70))}`);
}
console.log(`\n共 ${changes.length} 處${APPLY ? '' : '（dry-run）'}`);
