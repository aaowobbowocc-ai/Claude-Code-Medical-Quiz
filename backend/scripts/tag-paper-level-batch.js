#!/usr/bin/env node
// 批次為 tcm1 / tcm2 / nutrition / social-worker 套用 paper-level tagging：
// 每個 paper 的 subject 直接映射成 subject_tag + stage_id，不做卷內切段。
//
// 適用場景：考選部不規定子科目比例、題目混排不穩定、無可靠題號邊界。
// 使用者仍可按卷別篩題。

const fs = require('fs')
const path = require('path')

const CONFIGS = {
  tcm1: {
    file: 'questions-tcm1.json',
    mapping: {
      '中醫基礎醫學(一)': { tag: 'tcm_basic_1', name: '中醫基礎醫學(一)', stage_id: 1 },
      '中醫基礎醫學(二)': { tag: 'tcm_basic_2', name: '中醫基礎醫學(二)', stage_id: 2 },
    }
  },
  tcm2: {
    file: 'questions-tcm2.json',
    mapping: {
      '中醫臨床醫學(一)': { tag: 'tcm_clinical_1', name: '中醫臨床醫學(一)', stage_id: 1 },
      '中醫臨床醫學(二)': { tag: 'tcm_clinical_2', name: '中醫臨床醫學(二)', stage_id: 2 },
      '中醫臨床醫學(三)': { tag: 'tcm_clinical_3', name: '中醫臨床醫學(三)', stage_id: 3 },
      '中醫臨床醫學(四)': { tag: 'tcm_clinical_4', name: '中醫臨床醫學(四)', stage_id: 4 },
    }
  },
  nutrition: {
    file: 'questions-nutrition.json',
    mapping: {
      '膳食療養學':              { tag: 'diet_therapy',      name: '膳食療養學',    stage_id: 1 },
      '團體膳食設計與管理':      { tag: 'group_meal',        name: '團體膳食設計',  stage_id: 2 },
      '生理學與生物化學':        { tag: 'physio_biochem',    name: '生理生化',      stage_id: 3 },
      '營養學':                  { tag: 'nutrition_science', name: '營養學',        stage_id: 4 },
      '公共衛生營養學':          { tag: 'public_nutrition',  name: '公共衛生營養',  stage_id: 5 },
      '食品衛生與安全':          { tag: 'food_safety',       name: '食品衛生安全',  stage_id: 6 },
    }
  },
  'social-worker': {
    file: 'questions-social-worker.json',
    mapping: {
      '社會工作':         { tag: 'social_work',        name: '社會工作',       stage_id: 1 },
      '社會工作直接服務': { tag: 'social_work_direct', name: '社會工作直接服務', stage_id: 2 },
      '社會工作管理':     { tag: 'social_work_mgmt',   name: '社會工作管理',   stage_id: 3 },
    }
  },
  pt: {
    file: 'questions-pt.json',
    mapping: {
      '物理治療基礎學':                 { tag: 'pt_foundation',  name: '物理治療基礎學',  stage_id: 1 },
      '物理治療學概論':                 { tag: 'pt_intro',       name: '物理治療學概論',  stage_id: 2 },
      '物理治療技術學':                 { tag: 'pt_techniques',  name: '物理治療技術學',  stage_id: 3 },
      '神經疾病物理治療學':             { tag: 'pt_neuro',       name: '神經疾病物理治療',  stage_id: 4 },
      '骨科疾病物理治療學':             { tag: 'pt_ortho',       name: '骨科疾病物理治療',  stage_id: 5 },
      '心肺疾病與小兒疾病物理治療學':   { tag: 'pt_cardio_peds', name: '心肺與小兒物理治療', stage_id: 6 },
    }
  },
  ot: {
    file: 'questions-ot.json',
    mapping: {
      '解剖學與生理學':       { tag: 'ot_anatomy_physio', name: '解剖與生理',  stage_id: 1 },
      '職能治療學概論':       { tag: 'ot_intro',          name: '職能治療學概論', stage_id: 2 },
      '生理疾病職能治療學':   { tag: 'ot_physical',       name: '生理疾病職能治療', stage_id: 3 },
      '心理疾病職能治療學':   { tag: 'ot_mental',         name: '心理疾病職能治療', stage_id: 4 },
      '小兒疾病職能治療學':   { tag: 'ot_pediatrics',     name: '小兒疾病職能治療', stage_id: 5 },
      '職能治療技術學':       { tag: 'ot_techniques',     name: '職能治療技術學', stage_id: 6 },
    }
  },
  radiology: {
    file: 'questions-radiology.json',
    mapping: {
      '基礎醫學（包括解剖學、生理學與病理學）':  { tag: 'rad_basic',        name: '基礎醫學',       stage_id: 1 },
      '醫學物理學與輻射安全':                    { tag: 'rad_physics',      name: '醫學物理與輻安', stage_id: 2 },
      '放射線器材學（包括磁振學與超音波學）':    { tag: 'rad_equipment',    name: '放射器材',       stage_id: 3 },
      '放射線診斷原理與技術學':                  { tag: 'rad_diagnostic',   name: '放射診斷',       stage_id: 4 },
      '放射線治療原理與技術學':                  { tag: 'rad_therapy',      name: '放射治療',       stage_id: 5 },
      '核子醫學診療原理與技術學':                { tag: 'rad_nuclear',      name: '核子醫學',       stage_id: 6 },
    }
  },
}

function run(examId) {
  const cfg = CONFIGS[examId]
  const qfile = path.join(__dirname, '..', cfg.file)
  const data = JSON.parse(fs.readFileSync(qfile, 'utf8'))
  const arr = Array.isArray(data) ? data : data.questions
  const stats = {}
  let unmapped = 0
  for (const q of arr) {
    const m = cfg.mapping[q.subject]
    if (!m) { unmapped++; continue }
    q.subject_tag  = m.tag
    q.subject_name = m.name
    q.stage_id     = m.stage_id
    stats[m.tag] = (stats[m.tag] || 0) + 1
  }
  console.log(`\n=== ${examId} ===`)
  for (const [t, c] of Object.entries(stats).sort((a,b)=>b[1]-a[1])) console.log(' ', t.padEnd(22), c)
  console.log('unmapped:', unmapped)

  if (!process.argv.includes('--dry-run')) {
    const tmp = qfile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, qfile)
    console.log('wrote', cfg.file)
  }
}

for (const examId of Object.keys(CONFIGS)) run(examId)
if (process.argv.includes('--dry-run')) console.log('\n(dry-run, no writes)')
