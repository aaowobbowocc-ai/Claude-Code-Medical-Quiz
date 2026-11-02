#!/usr/bin/env node
/**
 * 清 jsDelivr edge 快取。
 *
 * 為什麼需要：App 取題走 cdn.jsdelivr.net 的 @master ref，jsDelivr 會把
 * 「@master → 哪個 commit」的解析結果快取約 12 小時。push 完不 purge 的話，
 * 使用者最久要等 12 小時才拿得到新題庫；更糟的是若此時 App 帶著新的
 * CACHE_VERSION 首次開啟，會把**舊資料**寫進新版本的 IndexedDB key，
 * 要再等 24 小時 TTL 才自救（2026-06-12 v6 就踩過）。
 *
 * 官方 purge endpoint：https://purge.jsdelivr.net/gh/{user}/{repo}@{ref}/{path}
 *
 * ⚠️ 2026-10-25 實測：**purge 只清 edge（CF + Fastly），不會重置
 *    「@master → commit」的解析快取。** 那層在 jsDelivr origin，
 *    s-maxage=43200（12 小時），而且沒有辦法強制更新：
 *      - 清檔案路徑、清 @master/、清 @master、清 @master/backend/ 都試過，purge
 *        回 status:finished / throttled:false，但帶 cache-buster 回源拿到的還是舊版
 *      - 用 @<完整 sha> 的 URL 立刻就是新版（所以 GitHub 端沒問題）
 *      - data.jsdelivr.com 的 resolve API 直接回 502／「Package size exceeded
 *        the configured limit of 50 MB」——這個 repo 追蹤了 ~3.2 GB
 *        （光 backend/_tmp 的 PDF 快取就 2.6 GB），所以 API 那條路也查不到
 *
 *    **所以一個 12 小時窗口內只有第一次 push 會即時生效。**
 *    題庫改動要**合併成一次 push + 一次 purge**，不要像這天一樣分三次 commit
 *    分三次 purge —— 第二、三次都要等 12 小時。
 *
 *    卡在舊版期間**絕對不要動 CACHE_VERSION / examRegistry 的 CACHE_KEY**，
 *    否則就是上面那個「舊資料寫進新 key、再等 24 小時」的坑。
 *
 *   node scripts/purge-jsdelivr.js                 清所有 questions*.json
 *   node scripts/purge-jsdelivr.js --commit <sha>  只清該 commit 改到的檔
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = 'aaowobbowocc-ai/Claude-Code-Medical-Quiz';
const REF = 'master';
const BK = path.join(__dirname, '..');
const sha = (process.argv.find(a => a.startsWith('--commit=')) || '').split('=')[1];

const get = u => new Promise((res, rej) => {
  https.get(u, { headers: { 'User-Agent': 'purge' }, timeout: 60000 }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => res({ code: r.statusCode, body: d }));
  }).on('error', rej);
});

let files;
if (sha) {
  files = execFileSync('git', ['show', '--name-only', '--pretty=format:', sha], { cwd: path.join(BK, '..') })
    .toString().split('\n').map(s => s.trim())
    .filter(f => /^backend\/questions.*\.json$/.test(f)).map(f => f.replace(/^backend\//, ''));
} else {
  files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f));
}

/**
 * 12 小時窗口檢查。
 *
 * purge 只清 edge，**清不掉「@master → 哪個 commit」的解析快取**
 * （那層在 jsDelivr origin，s-maxage=43200）。所以一個 12 小時窗口裡
 * 只有第一次 push 會即時生效，第二次之後都要等。
 *
 * 這件事檔頭與 memory 都寫了，但「今天是不是已經推過一次」要自己記，
 * 很容易漏。改成**跑的時候直接把 12 小時內的題庫 commit 列出來**。
 *
 * ⚠️ 另外注意：purge 完馬上去驗，edge 還要幾十秒才傳播完，
 *    這時候拿到舊版是正常的，**不要誤判成 ref 快取卡住**
 *    （2026-11-02 就這樣誤判過一次；回應標頭的 age 很小就是剛回源的意思）。
 */
function windowWarning() {
  try {
    const log = execFileSync('git', ['log', '--since=12.hours', '--pretty=format:%h %ad %s',
      '--date=format:%m-%d %H:%M', '--', 'backend/questions*.json'],
      { cwd: path.join(BK, '..') }).toString().trim();
    const lines = log ? log.split('\n').filter(Boolean) : [];
    if (lines.length <= 1) return;
    console.log(`\n⚠️  過去 12 小時內有 ${lines.length} 個 commit 動到題庫：`);
    lines.forEach((l, i) => console.log(`   ${i === lines.length - 1 ? '←最早' : '      '} ${l.slice(0, 88)}`));
    console.log('   jsDelivr 的「@master → commit」解析快取 12 小時，**只有最早那次即時生效**，');
    console.log('   後面的要等窗口過。purge 清的是 edge，清不掉這一層。');
    console.log('   下次把題庫改動合併成一次 push。');
    console.log('   卡住期間不要動 CACHE_VERSION／examRegistry 的 CACHE_KEY —— ');
    console.log('   App 會把舊資料寫進新 key，再等 24 小時 TTL 才自救。\n');
  } catch { /* 不在 git repo 裡就算了 */ }
}

(async () => {
  windowWarning();
  console.log('要清', files.length, '個檔案');
  let ok = 0, fail = 0;
  for (const f of files) {
    const url = `https://purge.jsdelivr.net/gh/${REPO}@${REF}/backend/${f}`;
    try {
      const r = await get(url);
      const j = JSON.parse(r.body);
      const done = j.status === 'finished';
      const throttled = Object.values(j.paths || {})[0]?.throttled;
      if (done && !throttled) { ok++; process.stdout.write('.'); }
      else { fail++; console.log(`\n  ! ${f}: status=${j.status} throttled=${throttled}`); }
    } catch (e) { fail++; console.log(`\n  ! ${f}: ${e.message.slice(0, 40)}`); }
  }
  console.log(`\n完成：成功 ${ok}，需重試 ${fail}`);
  if (fail) console.log('被 throttle 的稍後重跑一次即可（jsDelivr 對 purge 有頻率限制）');
})();
