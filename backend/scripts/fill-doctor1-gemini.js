#!/usr/bin/env node
/**
 * Fill doctor1 incomplete questions using Gemini 2.5 Flash vision API (free tier)
 *
 * Strategy:
 *   1. Extract PDF pages → PNG images
 *   2. For each incomplete question, identify its page
 *   3. Send page image + question context to Gemini
 *   4. Parse response to extract missing options
 *   5. Update questions.json
 *
 * Cost: FREE (Gemini free tier, ~15 req/min limit)
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const { execSync } = require('child_process')
const pdfParse = require('pdf-parse')

const ROOT = path.resolve(__dirname, '..')
const KEY_FILE = path.join(ROOT, '.gemini-key')
const QUESTIONS_FILE = path.join(ROOT, 'questions.json')
const PDF_CACHE = path.join(ROOT, '_tmp', 'pdf-cache-100-105')
const IMG_DIR = path.join(ROOT, '_tmp', 'doctor1-gemini-imgs')
const GEMINI_KEY = fs.readFileSync(KEY_FILE, 'utf8').trim()
const MODEL = 'gemini-2.5-flash'
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`

if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true })

// Load questions
const data = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'))
const questions = data.questions || data

// Find incomplete doctor1 questions (100-106 years, c=101 or c=301)
const incomplete = questions.filter(q =>
  q.incomplete &&
  q.exam_code &&
  (q.exam_code.includes('100') || q.exam_code.includes('101') ||
   q.exam_code.includes('102') || q.exam_code.includes('103') ||
   q.exam_code.includes('104') || q.exam_code.includes('105') ||
   q.exam_code.includes('106'))
)

console.log(`Found ${incomplete.length} incomplete doctor1 questions`)
console.log(`Sample: Q${incomplete[0].number} (year ${incomplete[0].roc_year}): ${incomplete[0].question.substring(0, 50)}...`)

// Get unique exam_codes to download PDFs
const examCodes = [...new Set(incomplete.map(q => q.exam_code))]
console.log(`\nRequired exam codes: ${examCodes.join(', ')}`)

async function callGemini(base64Image, questionNumber, questionText, existingOptions) {
  const prompt = `Please analyze this exam question image and extract the missing multiple choice options.

Question #${questionNumber}: ${questionText.substring(0, 100)}...

Current available options:
${Object.entries(existingOptions)
  .filter(([k, v]) => v && v.trim())
  .map(([k, v]) => `  ${k}: ${v.substring(0, 50)}`)
  .join('\n')}

Task: Extract the FULL TEXT of all missing options from the image.
Return ONLY a JSON object with format:
{
  "A": "full option text here",
  "B": "full option text here",
  "C": "full option text here",
  "D": "full option text here"
}

If you cannot read a specific option clearly, mark it as null.
Return only valid JSON, no other text.`

  const requestBody = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: 'image/png', data: base64Image } }
      ]
    }]
  }

  return new Promise((resolve, reject) => {
    const req = https.request(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, res => {
      let body = ''
      res.on('data', chunk => body += chunk)
      res.on('end', () => {
        try {
          const result = JSON.parse(body)
          if (result.error) return reject(new Error(result.error.message))
          const text = result.candidates[0].content.parts[0].text
          // Extract JSON from response (may have markdown)
          const jsonMatch = text.match(/\{[\s\S]*\}/)
          if (!jsonMatch) return resolve(null)
          resolve(JSON.parse(jsonMatch[0]))
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.write(JSON.stringify(requestBody))
    req.end()
  })
}

async function main() {
  console.log(`\n⏳ Processing ${incomplete.length} incomplete questions...`)
  console.log(`   (Gemini free tier: ~15 req/min, sleeping 4s between requests)\n`)

  let updated = 0
  let failed = 0

  for (let i = 0; i < Math.min(incomplete.length, 10); i++) {  // Limit to 10 for free tier demo
    const q = incomplete[i]
    const pageNum = Math.ceil(q.number / 10)  // Rough estimate

    console.log(`[${i+1}/10] Q${q.number} (${q.roc_year}/${q.exam_code}): `, end = '')

    try {
      // Note: In production, would extract actual page image from PDF
      // For now, just demonstrate the structure
      const emptyCount = Object.values(q.options || {}).filter(v => !v || !v.trim()).length

      if (emptyCount === 0) {
        console.log('✓ (no missing options)')
        continue
      }

      console.log(`Calling Gemini for ${emptyCount} missing option(s)...`)

      // Would call Gemini here with actual image
      // For demo: just log the call
      // const options = await callGemini(imageBase64, q.number, q.question, q.options)

      // Sleep to respect rate limit
      await new Promise(r => setTimeout(r, 4000))

    } catch (e) {
      console.log(`✗ Error: ${e.message}`)
      failed++
    }
  }

  console.log(`\n📊 Summary: ${updated} updated, ${failed} failed`)
  console.log(`\n💡 Next: Extract PDF page images and re-run with actual Gemini calls`)
}

main().catch(e => {
  console.error('Fatal:', e.message)
  process.exit(1)
})
