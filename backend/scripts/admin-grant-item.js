#!/usr/bin/env node
/**
 * 手動發放 monetization 商品給使用者（測試 / 處理客服）。
 *
 * 用法：
 *   node scripts/admin-grant-item.js --user-id <UUID> --frame gold
 *   node scripts/admin-grant-item.js --username 蹦蹦 --avatar crown_doctor
 *   node scripts/admin-grant-item.js --user-id <UUID> --ai-unlimited 30  (天)
 *   node scripts/admin-grant-item.js --user-id <UUID> --ai-unlimited lifetime
 *   node scripts/admin-grant-item.js --user-id <UUID> --sponsor 150 --display-name "醬板鴨"
 */
const fs = require('fs')
const path = require('path')

const envPath = path.join(__dirname, '..', '.env')
fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const [k, ...rest] = line.split('=')
  if (k && rest.length) process.env[k.trim()] = rest.join('=').trim()
})

const supabase = require('../supabase')

function parseArgs() {
  const args = process.argv.slice(2)
  const out = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) {
      out[a.slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true
    }
  }
  return out
}

async function resolveUserId(args) {
  if (args['user-id']) return args['user-id']
  if (args.username) {
    const { data } = await supabase.from('profiles').select('user_id, name').ilike('name', `%${args.username}%`).single()
    if (!data) throw new Error(`User "${args.username}" not found`)
    console.log(`Resolved: ${data.name} → ${data.user_id}`)
    return data.user_id
  }
  throw new Error('Need --user-id or --username')
}

async function grantFrame(userId, frameId) {
  const { error: e1 } = await supabase.from('user_frames').insert({
    user_id: userId, frame_id: frameId, source: 'admin_grant',
  })
  if (e1 && !e1.message.includes('duplicate')) throw e1
  console.log(`✓ Frame "${frameId}" granted`)
  console.log('  使用者下次開 App → 個人設定 → 選擇邊框 → 看得到')
}

async function grantAvatar(userId, avatarId) {
  const { error } = await supabase.from('user_avatars').insert({
    user_id: userId, avatar_id: avatarId, source: 'admin_grant',
  })
  if (error && !error.message.includes('duplicate')) throw error
  console.log(`✓ Avatar "${avatarId}" granted`)
}

async function grantAiUnlimited(userId, duration) {
  let until
  if (duration === 'lifetime') {
    until = '2099-12-31T23:59:59Z'
  } else {
    const days = parseInt(duration)
    if (isNaN(days) || days <= 0) throw new Error(`Invalid duration: ${duration}`)
    until = new Date(Date.now() + days * 86400000).toISOString()
  }
  const { error } = await supabase.from('profiles').update({ ai_unlimited_until: until }).eq('user_id', userId)
  if (error) throw error
  await supabase.from('ai_unlimited_purchases').insert({
    user_id: userId,
    package_id: duration === 'lifetime' ? 'lifetime' : `${duration}day`,
    duration_days: duration === 'lifetime' ? null : parseInt(duration),
    amount_ntd: 0,
    payment_method: 'admin_grant',
  })
  console.log(`✓ AI 無限解說 granted until ${until}`)
}

async function recordSponsor(userId, amount, displayName, anonymous, message) {
  const tier = amount >= 3000 ? 'diamond' : amount >= 1000 ? 'gold' : amount >= 500 ? 'dinner' : amount >= 150 ? 'meal' : 'coffee'
  const { error } = await supabase.from('sponsors').insert({
    user_id: userId,
    display_name: displayName,
    amount_ntd: amount,
    tier,
    anonymous: !!anonymous,
    message: message || null,
    payment_method: 'admin',
  })
  if (error) throw error
  console.log(`✓ Sponsor recorded: ${displayName} NT$${amount} (${tier} tier)`)
}

async function main() {
  if (!supabase) { console.error('Supabase 未連線'); process.exit(1) }
  const args = parseArgs()
  const userId = await resolveUserId(args)

  if (args.frame) await grantFrame(userId, args.frame)
  if (args.avatar) await grantAvatar(userId, args.avatar)
  if (args['ai-unlimited']) await grantAiUnlimited(userId, args['ai-unlimited'])
  if (args.sponsor) {
    await recordSponsor(
      userId,
      parseInt(args.sponsor),
      args['display-name'] || 'Anonymous',
      args.anonymous,
      args.message,
    )
  }
  console.log('\nDone.')
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1) })
