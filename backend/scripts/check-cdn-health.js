#!/usr/bin/env node
/**
 * 掃 jsDelivr 上的每一份題庫，看有沒有取不到的。
 *
 * 為什麼需要：整包 repo 已經 578 MB（question-images 305 MB ＋ 題庫 JSON 170 MB），
 * 超過 jsDelivr 的 50 MB package 上限。平常靠 edge 快取撐著沒事，但
 * **purge 之後那個窗口**會對「還沒重新快取到」的檔回
 *   403 Package size exceeded the configured limit of 50 MB
 * 2026-11-19 實測：purge 完第一次掃 nursing / nutrition 403，
 * 十分鐘後換成 state-mgmt / teacher-elementary / teacher-kindergarten，
 * 再過一陣子全部自己好了。所以它會**轉**、而且會自癒，
 * 但在那個窗口裡使用者是真的拿不到題庫
 * （前端已有 GitHub raw 退路，見 frontend/src/lib/cdnQuestions.js）。
 *
 * ⚠️ 抽幾個檔驗 hash 都對，不代表沒事 —— 中彈的是「沒快取到的那幾個」，
 *    要整批掃才看得出來。這也是這支存在的理由。
 *
 * 用 HEAD 探測：Range 請求 jsDelivr 不理（`bytes=0-200` 照樣回整包），
 * 用 GET 掃一輪是 170 MB 的流量，每天跑不起。
 *
 *   node scripts/check-cdn-health.js              掃一輪，印結果
 *   node scripts/check-cdn-health.js --wait       有壞的就等它自癒（purge 完用這個）
 *   node scripts/check-cdn-health.js --json       給 CI 用的機器可讀輸出
 *
 * 退出碼：0 = 全部 200；1 = 有檔取不到（--wait 等到超時仍有）。
 */
const fs = require('fs');
const path = require('path');

const BK = path.join(__dirname, '..');
const REPO = 'aaowobbowocc-ai/Claude-Code-Medical-Quiz';
const REF = 'master';
const CDN = `https://cdn.jsdelivr.net/gh/${REPO}@${REF}/backend/`;
const RAW = `https://raw.githubusercontent.com/${REPO}/${REF}/backend/`;

const WAIT = process.argv.includes('--wait');
const JSON_OUT = process.argv.includes('--json');
const WAIT_MINUTES = Number((process.argv.find(a => a.startsWith('--minutes=')) || '').split('=')[1]) || 20;

const files = fs.readdirSync(BK)
  .filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f) && !/\.bak/.test(f))
  .sort();

async function head(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return r.status;
  } catch (e) {
    return `ERR ${e.message}`;
  }
}

async function scan(list) {
  const bad = [];
  for (const f of list) {
    const s = await head(CDN + f);
    if (s !== 200) bad.push({ file: f, status: s });
  }
  return bad;
}

(async () => {
  const log = (...a) => { if (!JSON_OUT) console.log(...a); };
  let bad = await scan(files);
  log(`jsDelivr 掃 ${files.length} 份題庫｜取不到 ${bad.length} 份`);

  if (bad.length && WAIT) {
    // purge 完的窗口通常幾分鐘內自己好，每 60 秒重掃還沒好的那幾個
    const deadline = Date.now() + WAIT_MINUTES * 60_000;
    while (bad.length && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 60_000));
      bad = await scan(bad.map(b => b.file));
      log(`   還有 ${bad.length} 份取不到${bad.length ? '：' + bad.map(b => b.file).join(', ') : ''}`);
    }
  }

  // raw 退路也驗一下 —— 前端是靠它撐過 403 窗口的，它要是也掛了才是真的沒退路
  let rawOk = true;
  if (bad.length) {
    const s = await head(RAW + bad[0].file);
    rawOk = s === 200;
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ total: files.length, bad, rawOk }, null, 2));
  } else if (bad.length) {
    console.log('');
    for (const b of bad) console.log(`   ✗ ${b.file}  ${b.status}`);
    console.log('');
    console.log(rawOk
      ? '   GitHub raw 退路正常，使用者不會感覺到（cdnQuestions.js 會自動改走 raw）。'
      : '   ⚠️ GitHub raw 也取不到，使用者會整個掉回 Oracle 後端。');
    console.log('   這是 50 MB package 上限造成的，見 scripts/purge-jsdelivr.js 的註解。');
  } else {
    console.log('✅ 全部取得到');
  }
  process.exit(bad.length ? 1 : 0);
})();
