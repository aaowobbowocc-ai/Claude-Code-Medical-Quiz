#!/usr/bin/env node
/**
 * 學測／分科是五個選項（A~E），但 scrape-ceec.js 只認 (A)~(D)，
 * 第五個選項整段被留在 D 裡面：
 *   D: "丁 (E) 戊"                                   ← 選項 D 變兩個選項黏在一起
 *   D: "磁場…甲＞乙 (E) 磁場…甲＞乙 圖1 甲 乙 H 圖2 B 乙 甲 111 年分科 第 2 頁 …"
 * 於是使用者看到的 D 是錯的，而且根本沒有 E 可選。
 *
 * 這支把 D 從第一個 "(E)" 切開，後段補成選項 E，並把卷面殘渣
 * （頁碼、圖號、節次標題）從 E 的尾巴剪掉——**只認明確標記**，
 * 其他一律留著（切壞好選項比少修還糟，見 procedure_health_report_rules）。
 *
 * 詞彙選填題（選項一路排到 (F)(G)…(J)）不在處理範圍，跳過。
 *
 *   node scripts/repair-ceec-fifth-option.js            # dry-run
 *   node scripts/repair-ceec-fifth-option.js --apply
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./lib/atomic-write');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const FILES = ['questions-ast.json', 'questions-gsat.json'];

// 卷面殘渣的起點。命中就從那裡切掉，沒命中就整段留著。
const JUNK = [
  /\s*\d{2,3}\s*年\s*(分科|學測)/,          // 111 年分科 / 110 年學測
  /\s*第\s*\d+\s*頁/,
  /\s*共\s*\d+\s*頁/,
  /\s*[-－]\s*\d+\s*[-－]\s*$/,
  /\s*[一二三四五六]\s*、\s*(單|多)選題/,
  /\s*第\s*[壹貳參肆]\s*部分/,
  /\s*說明\s*[：:︰]/,
  /\s*（\s*占\s*\d+\s*分\s*）/,
  /\s*\d+\s*[-－~～至]\s*\d+\s*題?\s*為題組/,
  /\s*第\s*\d+\s*題至第\s*\d+\s*題/,
  // 圖號／表號只在**尾巴**才算殘渣，而且後面不能接「所示/中/的/之」
  //（「如圖7所示」是選項正文的一部分，切了就把句子砍斷）
  /\s+[圖表]\s*[一二三四五六\d]+\s*(?![所中的之])/,
];

/**
 * 圖的座標軸文字被 PDF 一起吐出來時，同一段會**重複好幾次**
 * （104 自然 #22 的「密度（公斤/立方公尺） 深度︵公尺︶」出現三遍）。
 * 正常的選項不會把一段 12 字以上的文字再講一次，所以看到重複就從第二次那裡切。
 */
// ⚠️ 試過兩條「看形狀」的規則，兩條都把好選項切壞了，已移除：
//   「連續 4 組以上的數字當座標軸」→ 109 學測自然 #58 的
//      「1.0×10⁻⁶ M」被削掉，四個選項變成兩兩重複；
//      108 社會 #57 的「1707、1800 年的聯合法」也不見了。
//   「同一段重複出現就切」→ 106 國文 #13 的「孔乙己還欠十九個錢呢！」
//      原文就是講兩次；114 地理 #40 的「減去平日日間活動人數的欄位數值」也是。
// 圖表座標軸的文字就留著，宁可少修。

function cleanTail(t) {
  let out = t;
  for (const re of JUNK) {
    const m = re.exec(out);
    if (m && m.index > 0) out = out.slice(0, m.index);
  }
  return out.trim();
}

let total = 0, skipped = 0;
for (const f of FILES) {
  const p = path.join(BK, f);
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const arr = data.questions || data;
  let n = 0;
  for (const q of arr) {
    const d = String((q.options || {}).D || '');
    const i = d.search(/\(\s*E\s*\)/);
    if (i < 0) continue;
    // 詞彙選填：選項排到 F 以後，切法完全不同，不碰
    if (/\(\s*[F-J]\s*\)/.test(d)) { skipped++; continue; }
    if (q.options.E) { skipped++; continue; }
    const head = cleanTail(d.slice(0, i));
    const tail = cleanTail(d.slice(i).replace(/^\(\s*E\s*\)\s*/, ''));
    if (!head || !tail) { skipped++; continue; }
    if (n < 6) {
      console.log(`  ${f.slice(10, -5)} ${q.roc_year} ${q.subject} #${q.number} 答${q.answer}`);
      console.log(`    舊D: ${JSON.stringify(d.slice(0, 90))}`);
      console.log(`    新D: ${JSON.stringify(head.slice(0, 60))}`);
      console.log(`    新E: ${JSON.stringify(tail.slice(0, 60))}`);
    }
    if (APPLY) { q.options.D = head; q.options.E = tail; }
    n++; total++;
  }
  console.log(`${f}: 拆出第五個選項 ${n} 題`);
  if (APPLY && n) atomicWriteJson(p, data);
}
console.log(`\n共 ${total} 題；跳過 ${skipped} 題（詞彙選填或切不出兩段）${APPLY ? '' : '（dry-run）'}`);
