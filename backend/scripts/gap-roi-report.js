#!/usr/bin/env node
/**
 * Gap ROI Report Generator
 * Analyzes missing questions by exam and calculates ROI based on traffic × gap size × difficulty
 * ROI formula: missingCount × trafficWeight × (1 / difficulty)
 * - difficulty: 1=standard MoEX | 3=image-dep incomplete | 5=permanent 302 redirect
 */

const fs = require('fs')
const path = require('path')

const BACKEND = path.resolve(__dirname, '..')
const CONFIGS_DIR = path.join(BACKEND, 'exam-configs')
const TMP_DIR = path.join(BACKEND, '_tmp')
const QUESTIONS_DIR = BACKEND

// Map contentGroup name (from GA4) to examId
const CONTENT_GROUP_TO_EXAM = {
  '醫師國考第一階段': 'doctor1',
  '醫師國考第二階段': 'doctor2',
  '牙醫師國考第一階段': 'dental1',
  '牙醫師國考第二階段': 'dental2',
  '藥師國考第一階段': 'pharma1',
  '藥師國考第二階段': 'pharma2',
  '護理師國考': 'nursing',
  '營養師國考': 'nutrition',
  '物理治療師國考': 'pt',
  '職能治療師國考': 'ot',
  '醫事檢驗師國考': 'medlab',
  '醫事放射師國考': 'radiology',
  '中醫師國考': 'tcm',
  '獸醫師國考': 'vet',
  '社會工作師國考': 'social-worker',
  // Fallback mapping
  'doctor1': 'doctor1',
  'doctor2': 'doctor2',
  'dental1': 'dental1',
  'dental2': 'dental2',
  'pharma1': 'pharma1',
  'pharma2': 'pharma2',
  'nursing': 'nursing',
  'nutrition': 'nutrition',
  'pt': 'pt',
  'ot': 'ot',
  'medlab': 'medlab',
}

// Difficulty mapping for gap reasons
const DIFFICULTY_WEIGHT = {
  'missing_image_dep': 3,        // Image-dependent, needs OCR
  'missing_format': 2,           // Format parsing issue, recoverable
  'missing_never': 5,            // Never available (302 redirect)
  'missing_unknown': 2,          // Unknown reason, investigate
}

async function main() {
  // Load GA4 traffic data
  const gaSnapshotDate = fs.readdirSync(path.join(TMP_DIR, 'ga-snapshot')).pop()
  const gaPath = path.join(TMP_DIR, 'ga-snapshot', gaSnapshotDate, 'ga4.json')
  const gaData = JSON.parse(fs.readFileSync(gaPath, 'utf8'))

  // Map exams to traffic
  const examTraffic = {}
  const maxTraffic = {}

  if (gaData.exams && gaData.exams.rows) {
    for (const row of gaData.exams.rows) {
      const contentGroup = row.dimensionValues[0]?.value
      const views = parseInt(row.metricValues[0]?.value || 0)

      if (!contentGroup || contentGroup === '(not set)' || contentGroup === '') continue

      const examId = CONTENT_GROUP_TO_EXAM[contentGroup]
      if (examId) {
        examTraffic[examId] = views
        if (!maxTraffic.max) maxTraffic.max = views
        if (views > maxTraffic.max) maxTraffic.max = views
      }
    }
  }

  // Normalize traffic to 0-1 scale
  const maxViews = maxTraffic.max || 1
  const normalizedTraffic = {}
  for (const [exam, views] of Object.entries(examTraffic)) {
    normalizedTraffic[exam] = views / maxViews
  }

  // Scan questions for gaps
  const examGaps = {}
  const allExams = fs.readdirSync(CONFIGS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))

  for (const examId of allExams) {
    const configPath = path.join(CONFIGS_DIR, `${examId}.json`)
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const questionsFile = config.questionsFile || `questions-${examId}.json`
    const questionsPath = path.join(QUESTIONS_DIR, questionsFile)

    if (!fs.existsSync(questionsPath)) {
      continue
    }

    try {
      const data = JSON.parse(fs.readFileSync(questionsPath, 'utf8'))
      const questions = Array.isArray(data) ? data : (data.questions || [])

      // Count incomplete and missing by gap reason
      const gaps = {}
      let totalIncomplete = 0
      let totalMissing = 0

      for (const q of questions) {
        if (q.incomplete) {
          totalIncomplete++
          const reason = q.gap_reason || 'missing_unknown'
          gaps[reason] = (gaps[reason] || 0) + 1
        }
      }

      examGaps[examId] = {
        totalIncomplete,
        totalMissing: 0,  // Would need historical comparison to calculate
        gapReasons: gaps,
        totalQuestions: questions.length || data.total || 0,
      }
    } catch (e) {
      console.error(`Failed to load ${questionsPath}: ${e.message}`)
    }
  }

  // Calculate ROI for each exam
  const roiScores = []

  for (const [examId, gapData] of Object.entries(examGaps)) {
    if (gapData.totalIncomplete === 0) continue

    const traffic = normalizedTraffic[examId] || 0
    if (traffic === 0) continue  // Skip exams with no traffic

    // Calculate weighted difficulty
    let totalDifficulty = 0
    for (const [reason, count] of Object.entries(gapData.gapReasons)) {
      const difficulty = DIFFICULTY_WEIGHT[reason] || 2
      totalDifficulty += difficulty * count
    }
    const avgDifficulty = totalDifficulty / gapData.totalIncomplete || 1

    const roi = gapData.totalIncomplete * traffic / avgDifficulty

    roiScores.push({
      examId,
      traffic: (traffic * 100).toFixed(1),
      incomplete: gapData.totalIncomplete,
      avgDifficulty: avgDifficulty.toFixed(2),
      roi: roi.toFixed(2),
      totalQuestions: gapData.totalQuestions,
      gapReasons: gapData.gapReasons,
    })
  }

  // Sort by ROI descending
  roiScores.sort((a, b) => parseFloat(b.roi) - parseFloat(a.roi))

  // Generate markdown report
  let markdown = `# Gap ROI Report\n\n`
  markdown += `Generated: ${new Date().toISOString()}\n`
  markdown += `Traffic data from: ${gaSnapshotDate}\n\n`

  markdown += `## Top 10 ROI Gaps\n\n`
  markdown += `| Rank | Exam | Incomplete | Traffic % | Avg Difficulty | ROI Score |\n`
  markdown += `|------|------|-----------|-----------|-----------------|----------|\n`

  for (let i = 0; i < Math.min(10, roiScores.length); i++) {
    const score = roiScores[i]
    markdown += `| ${i + 1} | ${score.examId} | ${score.incomplete}/${score.totalQuestions} | ${score.traffic}% | ${score.avgDifficulty} | **${score.roi}** |\n`
  }

  markdown += `\n## Full Rankings\n\n`
  markdown += `| Exam | Incomplete | Traffic % | Avg Difficulty | ROI Score | Gap Types |\n`
  markdown += `|------|-----------|-----------|-----------------|----------|----------|\n`

  for (const score of roiScores) {
    const gaps = Object.entries(score.gapReasons)
      .map(([reason, count]) => `${reason}(${count})`)
      .join(', ')
    markdown += `| ${score.examId} | ${score.incomplete}/${score.totalQuestions} | ${score.traffic}% | ${score.avgDifficulty} | ${score.roi} | ${gaps} |\n`
  }

  // Save outputs
  const reportPath = path.join(TMP_DIR, 'gap-roi-report.md')
  const jsonPath = path.join(TMP_DIR, 'gap-roi-report.json')

  fs.writeFileSync(reportPath, markdown)
  fs.writeFileSync(jsonPath, JSON.stringify({ scores: roiScores, traffic: examTraffic, timestamp: new Date().toISOString() }, null, 2))

  console.log(`📊 ROI Report Generated`)
  console.log(`   Markdown: ${reportPath}`)
  console.log(`   JSON: ${jsonPath}`)
  console.log(`\n🎯 Top 3 Priority Gaps:\n`)

  for (let i = 0; i < Math.min(3, roiScores.length); i++) {
    const score = roiScores[i]
    console.log(`  ${i + 1}. ${score.examId} — ${score.incomplete} incomplete (ROI: ${score.roi}, Traffic: ${score.traffic}%)`)
  }
}

main().catch(e => {
  console.error('Error:', e.message)
  process.exit(1)
})
