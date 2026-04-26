#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
envContent.split('\n').forEach(line => {
  const [key, value] = line.split('=');
  if (key && value) process.env[key.trim()] = value.trim();
});

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function search(keyword) {
  console.log(`\n搜尋關鍵字："${keyword}"\n`);

  // 直接查詢 profiles
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .ilike('username', `%${keyword}%`)
    .limit(20);

  if (error) {
    console.error('錯誤:', error.message);
    return;
  }

  if (!data || data.length === 0) {
    console.log('找不到相關用戶');
    return;
  }

  console.log(`找到 ${data.length} 個用戶：\n`);
  data.forEach((user, i) => {
    console.log(`${i + 1}. username: ${user.username}`);
    console.log(`   user_id: ${user.user_id}`);
    console.log(`   id: ${user.id}`);
    console.log('');
  });
}

const keyword = process.argv[2] || '啊啊啊';
search(keyword).then(() => process.exit(0));
