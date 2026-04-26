#!/usr/bin/env node
/**給個人用戶發金幣獎勵（透過 user_coin_grants）*/

const fs = require('fs');
const path = require('path');

// 讀取 .env
const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
envContent.split('\n').forEach(line => {
  const [key, value] = line.split('=');
  if (key && value) process.env[key.trim()] = value.trim();
});

const supabase = require('../supabase');

async function grantCoins(userIdentifier, coins, reason, fromName, isDirectId = false) {
  if (!supabase) {
    console.error('Supabase 未連線');
    process.exit(1);
  }

  console.log(`\n=== 金幣獎勵發放 ===\n`);

  let userId;

  if (isDirectId) {
    // 直接使用 user_id
    userId = userIdentifier;
    console.log(`✓ 使用者 ID：${userId}\n`);
  } else {
    // 1. 從 profiles 表查詢
    const { data: profile } = await supabase
      .from('profiles')
      .select('user_id, name')
      .ilike('name', `%${userIdentifier}%`)
      .single();

    if (!profile) {
      console.error(`❌ 找不到用戶 "${userIdentifier}"`);
      process.exit(1);
    }
    userId = profile.user_id;
    console.log(`✓ 找到用戶：${profile.name}`);
    console.log(`  ID：${userId}\n`);
  }

  // 2. 插入 user_coin_grants
  const { data: grant, error: insertErr } = await supabase
    .from('user_coin_grants')
    .insert({
      user_id: userId,
      coins: coins,
      reason: reason,
      from_name: fromName || 'Platform Admin'
    })
    .select();

  if (insertErr) {
    console.error(`❌ 插入失敗：${insertErr.message}`);
    process.exit(1);
  }

  console.log(`✓ 獎勵已創建`);
  console.log(`  金幣：${coins}`);
  console.log(`  原因：${reason}`);
  console.log(`  狀態：待認領\n`);
  console.log(`📨 用戶下次登入時會看到獎勵通知\n`);

  console.log(`=== 完成 ===\n`);
}

const args = process.argv.slice(2);
let userIdentifier = '啊啊啊';
let coins = 1000;
let reason = '感謝你的寶貴回報，幫助我們改進題庫品質。';
let fromName = '平台團隊';
let isDirectId = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--user-id') {
    userIdentifier = args[i + 1];
    isDirectId = true;
  }
  if (args[i] === '--username') {
    userIdentifier = args[i + 1];
    isDirectId = false;
  }
  if (args[i] === '--coins') coins = parseInt(args[i + 1]);
  if (args[i] === '--reason') reason = args[i + 1];
  if (args[i] === '--from') fromName = args[i + 1];
}

grantCoins(userIdentifier, coins, reason, fromName, isDirectId).catch(console.error);
