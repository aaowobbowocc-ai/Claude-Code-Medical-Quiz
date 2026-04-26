#!/usr/bin/env node
/**給個人用戶發金幣獎勵*/

const fs = require('fs');
const path = require('path');

// 直接讀取 .env
const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
envContent.split('\n').forEach(line => {
  const [key, value] = line.split('=');
  if (key && value) process.env[key.trim()] = value.trim();
});

const supabase = require('../supabase');

async function rewardUser(username, coins, message) {
  if (!supabase) {
    console.error('Supabase 未連線');
    process.exit(1);
  }

  console.log(`\n=== 個人獎勵發放 ===\n`);
  console.log(`用戶：${username}`);
  console.log(`獎勵：${coins} 金幣`);
  console.log(`訊息：${message}\n`);

  // 1. 查找用戶
  const { data: user, error: findErr } = await supabase
    .from('profiles')
    .select('id, username, coins')
    .eq('username', username)
    .single();

  if (findErr || !user) {
    console.error(`❌ 找不到用戶 "${username}"`);
    console.error(findErr?.message || '');
    process.exit(1);
  }

  console.log(`✓ 找到用戶：${user.username} (ID: ${user.id})`);
  console.log(`  現有金幣：${user.coins || 0}`);

  // 2. 更新金幣
  const newCoins = (user.coins || 0) + coins;
  const { data: updated, error: updateErr } = await supabase
    .from('profiles')
    .update({ coins: newCoins })
    .eq('id', user.id)
    .select();

  if (updateErr) {
    console.error(`❌ 更新失敗：${updateErr.message}`);
    process.exit(1);
  }

  console.log(`✓ 更新成功`);
  console.log(`  新金幣數：${newCoins}\n`);

  // 3. 記錄訊息（可選：存到某個表）
  console.log(`📨 感謝訊息（應直接發送給用戶）：\n`);
  console.log(`   ${message}\n`);

  console.log(`=== 完成 ===\n`);
}

// 命令行參數解析
const args = process.argv.slice(2);
let username = '啊啊啊';
let coins = 1000;
let message = '感謝你的寶貴回報！已獎勵 1000 金幣。';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--username') username = args[i + 1];
  if (args[i] === '--coins') coins = parseInt(args[i + 1]);
  if (args[i] === '--message') message = args[i + 1];
}

rewardUser(username, coins, message).catch(console.error);
