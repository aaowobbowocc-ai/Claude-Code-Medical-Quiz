#!/usr/bin/env node
/**
 * Upload 126 motorcycle hazard perception videos to Cloudflare R2.
 *
 * Required env (in backend/.env):
 *   R2_ACCOUNT_ID
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *   R2_BUCKET   (default: examking-hazard-videos)
 *
 * Source: backend/_tmp/hazard-videos/機車筆試測驗危險感知題目影片/*.mp4
 * Destination key: hazard-moto/<videoId>.mp4   (e.g. hazard-moto/4142.mp4)
 *
 * Idempotent — skips files already in R2 (HEAD check).
 */
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3')

const VIDEO_DIR = path.resolve(__dirname, '..', '_tmp', 'hazard-videos', '機車筆試測驗危險感知題目影片')
const BUCKET = process.env.R2_BUCKET || 'examking-hazard-videos'
const KEY_PREFIX = 'hazard-moto'

function need(name) {
  const v = process.env[name]
  if (!v) { console.error(`✗ Missing env: ${name}`); process.exit(1) }
  return v
}

const accountId = need('R2_ACCOUNT_ID')
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: need('R2_ACCESS_KEY_ID'),
    secretAccessKey: need('R2_SECRET_ACCESS_KEY'),
  },
})

async function exists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
    return true
  } catch (e) {
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false
    throw e
  }
}

async function upload(file) {
  const videoId = path.basename(file, '.mp4')
  const key = `${KEY_PREFIX}/${videoId}.mp4`
  if (await exists(key)) return { videoId, key, skipped: true }
  const body = fs.readFileSync(path.join(VIDEO_DIR, file))
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: 'video/mp4',
    CacheControl: 'public, max-age=31536000, immutable',
  }))
  return { videoId, key, size: body.length }
}

async function main() {
  if (!fs.existsSync(VIDEO_DIR)) {
    console.error(`✗ Video dir not found: ${VIDEO_DIR}`)
    process.exit(1)
  }
  const files = fs.readdirSync(VIDEO_DIR).filter(f => f.endsWith('.mp4')).sort()
  console.log(`📹 Found ${files.length} mp4 files`)
  console.log(`☁  Uploading to R2 bucket: ${BUCKET}`)
  console.log('')

  let uploaded = 0, skipped = 0, totalBytes = 0
  for (const f of files) {
    try {
      const r = await upload(f)
      if (r.skipped) {
        skipped++
        process.stdout.write(`. `)
      } else {
        uploaded++
        totalBytes += r.size
        process.stdout.write(`✓ ${r.videoId} `)
      }
      if ((uploaded + skipped) % 10 === 0) process.stdout.write('\n')
    } catch (e) {
      console.error(`\n✗ ${f}: ${e.message}`)
    }
  }
  console.log('')
  console.log('')
  console.log(`完成 — 新上傳 ${uploaded} 支，跳過 ${skipped} 支已存在`)
  console.log(`總上傳量：${(totalBytes / 1024 / 1024).toFixed(1)} MB`)
}

main().catch(e => { console.error(e); process.exit(1) })
