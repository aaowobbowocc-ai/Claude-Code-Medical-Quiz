#!/usr/bin/env node
/**
 * Add `video_url` field to questions-driver-moto.json hazard questions.
 * Each question with `hazard_video_id` gets:
 *   video_url = `${R2_PUBLIC_URL}/hazard-moto/${hazard_video_id}.mp4`
 *
 * Default R2_PUBLIC_URL is hardcoded — override via env if changed.
 */
const fs = require('fs')
const path = require('path')

const DEFAULT_PUBLIC_URL = 'https://pub-c6b3f9f30e5043dab124a6d5a2f70af2.r2.dev'
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || DEFAULT_PUBLIC_URL).replace(/\/$/, '')

const QUESTIONS_FILE = path.resolve(__dirname, '..', 'questions-driver-moto.json')

function main() {
  const data = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf-8'))
  let updated = 0, skipped = 0
  for (const q of data) {
    if (!q.hazard_video_id) continue
    const url = `${PUBLIC_URL}/hazard-moto/${q.hazard_video_id}.mp4`
    if (q.video_url === url) { skipped++; continue }
    q.video_url = url
    updated++
  }
  fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(data, null, 2) + '\n')
  console.log(`✓ ${updated} questions updated, ${skipped} unchanged`)
  console.log(`  example: ${PUBLIC_URL}/hazard-moto/4142.mp4`)
}

main()
