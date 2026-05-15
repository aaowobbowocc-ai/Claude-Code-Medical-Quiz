#!/usr/bin/env node
/**
 * 全面審計 nursing.json 各場污染情況
 * 流程：
 *   1. 對每個 exam_code，探可能的 c-code (101/105/107/109/110)
 *   2. fetch s=0601 (paper1) 確認 PDF header = 護理師
 *   3. 比對 DB Q1 vs PDF Q1
 *   4. 若不符合 → 標記整場污染
 *
 * 輸出：清單列每場 (code, subject) 是否污染 + 真實 PDF 位置
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')

const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')

const POSSIBLE_C = ['101', '102', '103', '105', '106', '107', '108', '109', '110']
// 護理師 5 卷對應的 s code 模式（嘗試多種）
const S_CANDIDATES = [
  ['0101','0102','0103','0104','0105'],  // 新式 4碼
  ['0501','0502','0503','0504','0505'],  // 100-105 c=105 模式
  ['0601','0602','0603','0604','0605'],  // 100-105 c=107/110 模式
  ['0701','0702','0703','0704','0705'],
  ['0108','0601','0602','0603','0604'],  // c=109 105+ 模式
  ['0501','0601','0602','0603','0604'],  // 混合
]

function get(url) {
  return new Promise(r => {
    https.get(url, x => {
      if (x.statusCode !== 200) return r({status:x.statusCode});
      const c=[]; x.on('data',d=>c.push(d)); x.on('end',()=>r({status:200,buf:Buffer.concat(c)}));
    }).on('error', () => r(null));
  });
}

async function getPdfHeader(buf) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf');
  return doc.loadPage(0).toStructuredText('preserve-whitespace').asText().slice(0,500).normalize('NFKC');
}

async function getPdfQ1(buf) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf');
  let txt = '';
  for (let i = 0; i < doc.countPages(); i++) txt += doc.loadPage(i).toStructuredText('preserve-whitespace').asText();
  const norm = txt.normalize('NFKC');
  const m = norm.match(/\n1\.\s*([^\n]{10,150})/) || norm.match(/\n1\s+([^\n]{20,150})/);
  return m?.[1]?.slice(0, 60) || null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function findNursingForCode(examCode) {
  // 試各種 c-code 組合，找到第一個 paper PDF header = 護理師
  for (const c of POSSIBLE_C) {
    for (const sList of S_CANDIDATES) {
      for (const s of sList.slice(0, 1)) {   // 只試第一卷確認
        const url = `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=Q&code=${examCode}&c=${c}&s=${s}&q=1`;
        const r = await get(url);
        await sleep(80);
        if (r?.status !== 200 || r.buf.length < 1000) continue;
        const head = await getPdfHeader(r.buf);
        if (/類\s*科[：:]?\s*護理師/.test(head)) {
          return { c, baseS: s, sList };
        }
      }
    }
  }
  return null;
}

async function main() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'questions-nursing.json'), 'utf-8'));
  const arr = data.questions || data;
  const codes = [...new Set(arr.map(q => q.exam_code))].sort();

  const results = [];
  for (const examCode of codes) {
    process.stdout.write(`\n${examCode}: probing...`);
    const found = await findNursingForCode(examCode);
    if (!found) {
      console.log(' ✗ no nursing PDF found');
      results.push({ examCode, status: 'no-pdf' });
      continue;
    }
    console.log(' ✓ c='+found.c+' s='+found.baseS);

    // 對每個 paper 拿 Q1
    const dbQ1s = {};
    for (const q of arr) {
      if (q.exam_code !== examCode || q.number !== 1) continue;
      dbQ1s[q.subject] = (q.question || '').slice(0, 60);
    }
    // 嘗試 fetch 多個 s 看 PDF 內容
    const pdfQ1s = {};
    for (const s of found.sList) {
      const url = `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=Q&code=${examCode}&c=${found.c}&s=${s}&q=1`;
      const r = await get(url);
      await sleep(80);
      if (r?.status !== 200 || r.buf.length < 1000) continue;
      const head = await getPdfHeader(r.buf);
      if (!/類\s*科[：:]?\s*護理師/.test(head)) continue;
      const subjMatch = head.match(/科\s*目[：:]?\s*([^\n]+)/);
      const sub = subjMatch?.[1]?.trim() || '?';
      pdfQ1s[sub] = { s, q1: await getPdfQ1(r.buf) };
    }
    results.push({
      examCode,
      c: found.c,
      dbQ1s,
      pdfQ1s,
    });
  }

  // Output report
  console.log('\n\n=== Audit Report ===');
  for (const r of results) {
    console.log('\n## ' + r.examCode + ' (c=' + (r.c || '?') + ')');
    if (r.status === 'no-pdf') { console.log('  No nursing PDF found (skipped)'); continue; }
    for (const [pdfSubj, info] of Object.entries(r.pdfQ1s)) {
      console.log('  PDF s=' + info.s + ' ['+pdfSubj.slice(0,40)+']');
      console.log('    PDF Q1:', info.q1);
      // Find matching DB subject heuristically
      for (const [dbSubj, dbQ1] of Object.entries(r.dbQ1s)) {
        const matchKey = pdfSubj.replace(/[()].*$/, '').trim();
        if (pdfSubj.includes(dbSubj.slice(0,4)) || dbSubj.includes(matchKey.slice(0,4))) {
          const same = dbQ1?.includes(info.q1?.slice(0,15)) || info.q1?.includes(dbQ1?.slice(0,15));
          console.log('    DB ['+dbSubj+'] Q1:', dbQ1, same ? '✓ MATCH' : '✗ MISMATCH');
        }
      }
    }
  }
  fs.writeFileSync(path.join(__dirname, '..', '_tmp', 'nursing-audit.json'), JSON.stringify(results, null, 2));
  console.log('\n\nSaved _tmp/nursing-audit.json');
}

main().catch(e => { console.error(e); process.exit(1); });
