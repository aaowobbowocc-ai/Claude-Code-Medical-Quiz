#!/usr/bin/env node
/**
 * recover-all-gaps.js — 全考試通用補題腳本
 *
 * 策略：
 *   1. 跑 find-gaps 邏輯找出所有缺題的 (exam, year, session, subject, 缺題號)
 *   2. 從考選部重新下載 PDF，用「非嚴格順序」的 parser 解析
 *   3. 答案從答案 PDF 取（全形字母解析）
 *   4. 只補缺題號對應的題，不動既有題目
 *   5. 若題目文字解析失敗（圖片題）但答案可取，建立 placeholder entry
 *
 * Usage:
 *   node scripts/recover-all-gaps.js --dry-run          # 只列出缺題，不下載
 *   node scripts/recover-all-gaps.js                     # 補全部
 *   node scripts/recover-all-gaps.js --exam doctor1      # 只補指定考試
 *   node scripts/recover-all-gaps.js --exam customs      # 只補指定考試
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const CACHE_DIR = path.join(__dirname, '..', '_tmp', 'pdf-cache-gaps')

// ─── All exam definitions ───
// Maps examId → { file, classCodes, papers, sessions }
// classCodes: class code per session-code series (old system used 2-digit s, new uses 4-digit)

const EXAM_DEFS = {
  doctor1: {
    file: 'questions.json',
    classCode: '301',
    papers: [
      { s: '11', subject: '醫學(一)', tag: 'anatomy' },
      { s: '22', subject: '醫學(二)', tag: 'pathology' },
    ],
    sessions: [
      { year: '106', session: '第二次', code: '106100' },
      { year: '107', session: '第一次', code: '107020' },
      { year: '107', session: '第二次', code: '107100' },
      { year: '108', session: '第一次', code: '108030' },
      { year: '108', session: '第二次', code: '108100' },
      { year: '109', session: '第一次', code: '109020' },
      { year: '109', session: '第二次', code: '109100' },
      { year: '110', session: '第二次', code: '110101' },
    ],
  },
  doctor2: {
    file: 'questions-doctor2.json',
    classCode: '302',
    papers: [
      { s: '11', subject: '醫學(三)', tag: 'internal_medicine' },
      { s: '22', subject: '醫學(四)', tag: 'pediatrics' },
      { s: '33', subject: '醫學(五)', tag: 'surgery' },
      { s: '44', subject: '醫學(六)', tag: 'medical_law_ethics' },
    ],
    sessions: [
      { year: '106', session: '第一次', code: '106020' },
      { year: '106', session: '第二次', code: '106080' },
      { year: '107', session: '第一次', code: '107020' },
      { year: '107', session: '第二次', code: '107080' },
      { year: '108', session: '第一次', code: '108030' },
      { year: '108', session: '第二次', code: '108080' },
      { year: '109', session: '第一次', code: '109020' },
      { year: '109', session: '第二次', code: '109080' },
      { year: '110', session: '第二次', code: '110080' },
      { year: '111', session: '第二次', code: '111080' },
      { year: '112', session: '第二次', code: '112080' },
    ],
  },
  dental1: {
    file: 'questions-dental1.json',
    classCode: '303',
    papers: [
      { s: '11', subject: '卷一', tag: 'dental_anatomy' },
      { s: '22', subject: '卷二', tag: 'oral_pathology' },
    ],
    sessions: [
      { year: '106', session: '第二次', code: '106100' },
      { year: '107', session: '第一次', code: '107020' },
      { year: '107', session: '第二次', code: '107100' },
      { year: '108', session: '第一次', code: '108030' },
      { year: '108', session: '第二次', code: '108100' },
      { year: '109', session: '第一次', code: '109020' },
      { year: '109', session: '第二次', code: '109100' },
    ],
  },
  dental2: {
    file: 'questions-dental2.json',
    classCode: '304',
    papers: [
      { s: '33', subject: '卷一', tag: 'periodontics' },
      { s: '44', subject: '卷二', tag: 'oral_surgery' },
      { s: '55', subject: '卷三', tag: 'fixed_prosthodontics' },
      { s: '66', subject: '卷四', tag: 'dental_public_health' },
    ],
    sessions: [
      { year: '106', session: '第一次', code: '106020' },
      { year: '106', session: '第二次', code: '106100' },
      { year: '107', session: '第一次', code: '107020' },
      { year: '107', session: '第二次', code: '107100' },
      { year: '108', session: '第一次', code: '108030' },
      { year: '108', session: '第二次', code: '108100' },
      { year: '109', session: '第一次', code: '109020' },
      { year: '109', session: '第二次', code: '109100' },
    ],
  },
  pharma2: {
    file: 'questions-pharma2.json',
    classCode: '306',
    papers: [
      { s: '44', subject: '調劑與臨床', tag: 'dispensing' },
      { s: '55', subject: '藥物治療', tag: 'pharmacotherapy' },
      { s: '66', subject: '法規', tag: 'pharmacy_law' },
    ],
    sessions: [
      { year: '106', session: '第一次', code: '106020' },
      { year: '106', session: '第二次', code: '106100' },
      { year: '107', session: '第一次', code: '107020' },
      { year: '107', session: '第二次', code: '107100' },
      { year: '108', session: '第一次', code: '108030' },
      { year: '108', session: '第二次', code: '108100' },
      { year: '109', session: '第一次', code: '109020' },
      { year: '109', session: '第二次', code: '109100' },
    ],
  },
  nursing: {
    file: 'questions-nursing.json',
    classCode: '101',
    papers: [
      { s: '0101', subject: '基礎醫學', tag: 'basic_medicine' },
      { s: '0102', subject: '基本護理學與護理行政', tag: 'basic_nursing' },
      { s: '0103', subject: '內外科護理學', tag: 'med_surg' },
      { s: '0104', subject: '產兒科護理學', tag: 'obs_ped' },
      { s: '0105', subject: '精神科與社區衛生護理學', tag: 'psych_community' },
    ],
    sessions: [
      { year: '114', session: '第一次', code: '114030' },
      { year: '115', session: '第一次', code: '115030' },
    ],
    // Old sessions with different class codes
    oldSessions: [
      { year: '106', session: '第一次', code: '106030', classCode: '101',
        papers: [
          { s: '0301', subject: '基礎醫學', tag: 'basic_medicine' },
          { s: '0302', subject: '基本護理學與護理行政', tag: 'basic_nursing' },
          { s: '0303', subject: '內外科護理學', tag: 'med_surg' },
          { s: '0304', subject: '產兒科護理學', tag: 'obs_ped' },
          { s: '0305', subject: '精神科與社區衛生護理學', tag: 'psych_community' },
        ]
      },
      { year: '106', session: '第二次', code: '106110', classCode: '101',
        papers: [
          { s: '0301', subject: '基礎醫學', tag: 'basic_medicine' },
          { s: '0302', subject: '基本護理學與護理行政', tag: 'basic_nursing' },
          { s: '0303', subject: '內外科護理學', tag: 'med_surg' },
          { s: '0304', subject: '產兒科護理學', tag: 'obs_ped' },
          { s: '0305', subject: '精神科與社區衛生護理學', tag: 'psych_community' },
        ]
      },
      { year: '107', session: '第一次', code: '107030', classCode: '101',
        papers: [
          { s: '0301', subject: '基礎醫學', tag: 'basic_medicine' },
          { s: '0302', subject: '基本護理學與護理行政', tag: 'basic_nursing' },
          { s: '0303', subject: '內外科護理學', tag: 'med_surg' },
          { s: '0304', subject: '產兒科護理學', tag: 'obs_ped' },
          { s: '0305', subject: '精神科與社區衛生護理學', tag: 'psych_community' },
        ]
      },
      { year: '107', session: '第二次', code: '107110', classCode: '104',
        papers: [
          { s: '0301', subject: '基礎醫學', tag: 'basic_medicine' },
          { s: '0302', subject: '基本護理學與護理行政', tag: 'basic_nursing' },
          { s: '0303', subject: '內外科護理學', tag: 'med_surg' },
          { s: '0304', subject: '產兒科護理學', tag: 'obs_ped' },
          { s: '0305', subject: '精神科與社區衛生護理學', tag: 'psych_community' },
        ]
      },
      { year: '108', session: '第一次', code: '108020', classCode: '101',
        papers: [
          { s: '0301', subject: '基礎醫學', tag: 'basic_medicine' },
          { s: '0302', subject: '基本護理學與護理行政', tag: 'basic_nursing' },
          { s: '0303', subject: '內外科護理學', tag: 'med_surg' },
          { s: '0304', subject: '產兒科護理學', tag: 'obs_ped' },
          { s: '0305', subject: '精神科與社區衛生護理學', tag: 'psych_community' },
        ]
      },
      { year: '108', session: '第二次', code: '108110', classCode: '104',
        papers: [
          { s: '0301', subject: '基礎醫學', tag: 'basic_medicine' },
          { s: '0302', subject: '基本護理學與護理行政', tag: 'basic_nursing' },
          { s: '0303', subject: '內外科護理學', tag: 'med_surg' },
          { s: '0304', subject: '產兒科護理學', tag: 'obs_ped' },
          { s: '0305', subject: '精神科與社區衛生護理學', tag: 'psych_community' },
        ]
      },
      { year: '109', session: '第一次', code: '109030', classCode: '101',
        papers: [
          { s: '0301', subject: '基礎醫學', tag: 'basic_medicine' },
          { s: '0302', subject: '基本護理學與護理行政', tag: 'basic_nursing' },
          { s: '0303', subject: '內外科護理學', tag: 'med_surg' },
          { s: '0304', subject: '產兒科護理學', tag: 'obs_ped' },
          { s: '0305', subject: '精神科與社區衛生護理學', tag: 'psych_community' },
        ]
      },
      { year: '109', session: '第二次', code: '109110', classCode: '104',
        papers: [
          { s: '0301', subject: '基礎醫學', tag: 'basic_medicine' },
          { s: '0302', subject: '基本護理學與護理行政', tag: 'basic_nursing' },
          { s: '0303', subject: '內外科護理學', tag: 'med_surg' },
          { s: '0304', subject: '產兒科護理學', tag: 'obs_ped' },
          { s: '0305', subject: '精神科與社區衛生護理學', tag: 'psych_community' },
        ]
      },
    ],
  },
  nutrition: {
    file: 'questions-nutrition.json',
    classCode: '102',
    papers: [
      { s: '0201', subject: '生理學與生物化學', tag: 'physio_biochem' },
      { s: '0202', subject: '營養學', tag: 'nutrition_science' },
      { s: '0203', subject: '膳食療養學', tag: 'diet_therapy' },
      { s: '0204', subject: '團體膳食設計與管理', tag: 'group_meal' },
      { s: '0205', subject: '公共衛生營養學', tag: 'public_nutrition' },
      { s: '0206', subject: '食品衛生與安全', tag: 'food_safety' },
    ],
    sessions: [
      { year: '114', session: '第一次', code: '114030' },
      { year: '115', session: '第一次', code: '115030' },
    ],
    oldSessions: [
      { year: '106', session: '第一次', code: '106030', classCode: '103',
        papers: [
          { s: '0201', subject: '生理學與生物化學', tag: 'physio_biochem' },
          { s: '0202', subject: '營養學', tag: 'nutrition_science' },
          { s: '0203', subject: '膳食療養學', tag: 'diet_therapy' },
          { s: '0204', subject: '團體膳食設計與管理', tag: 'group_meal' },
          { s: '0205', subject: '公共衛生營養學', tag: 'public_nutrition' },
          { s: '0206', subject: '食品衛生與安全', tag: 'food_safety' },
        ]
      },
      { year: '106', session: '第二次', code: '106110', classCode: '103',
        papers: [
          { s: '0201', subject: '生理學與生物化學', tag: 'physio_biochem' },
          { s: '0202', subject: '營養學', tag: 'nutrition_science' },
          { s: '0203', subject: '膳食療養學', tag: 'diet_therapy' },
          { s: '0204', subject: '團體膳食設計與管理', tag: 'group_meal' },
          { s: '0205', subject: '公共衛生營養學', tag: 'public_nutrition' },
          { s: '0206', subject: '食品衛生與安全', tag: 'food_safety' },
        ]
      },
      { year: '107', session: '第一次', code: '107030', classCode: '103',
        papers: [
          { s: '0201', subject: '生理學與生物化學', tag: 'physio_biochem' },
          { s: '0202', subject: '營養學', tag: 'nutrition_science' },
          { s: '0203', subject: '膳食療養學', tag: 'diet_therapy' },
          { s: '0204', subject: '團體膳食設計與管理', tag: 'group_meal' },
          { s: '0205', subject: '公共衛生營養學', tag: 'public_nutrition' },
          { s: '0206', subject: '食品衛生與安全', tag: 'food_safety' },
        ]
      },
      { year: '107', session: '第二次', code: '107110', classCode: '103',
        papers: [
          { s: '0201', subject: '生理學與生物化學', tag: 'physio_biochem' },
          { s: '0202', subject: '營養學', tag: 'nutrition_science' },
          { s: '0203', subject: '膳食療養學', tag: 'diet_therapy' },
          { s: '0204', subject: '團體膳食設計與管理', tag: 'group_meal' },
          { s: '0205', subject: '公共衛生營養學', tag: 'public_nutrition' },
          { s: '0206', subject: '食品衛生與安全', tag: 'food_safety' },
        ]
      },
      { year: '108', session: '第一次', code: '108020', classCode: '103',
        papers: [
          { s: '0201', subject: '生理學與生物化學', tag: 'physio_biochem' },
          { s: '0202', subject: '營養學', tag: 'nutrition_science' },
          { s: '0203', subject: '膳食療養學', tag: 'diet_therapy' },
          { s: '0204', subject: '團體膳食設計與管理', tag: 'group_meal' },
          { s: '0205', subject: '公共衛生營養學', tag: 'public_nutrition' },
          { s: '0206', subject: '食品衛生與安全', tag: 'food_safety' },
        ]
      },
      { year: '108', session: '第二次', code: '108110', classCode: '103',
        papers: [
          { s: '0201', subject: '生理學與生物化學', tag: 'physio_biochem' },
          { s: '0202', subject: '營養學', tag: 'nutrition_science' },
          { s: '0203', subject: '膳食療養學', tag: 'diet_therapy' },
          { s: '0204', subject: '團體膳食設計與管理', tag: 'group_meal' },
          { s: '0205', subject: '公共衛生營養學', tag: 'public_nutrition' },
          { s: '0206', subject: '食品衛生與安全', tag: 'food_safety' },
        ]
      },
      { year: '109', session: '第一次', code: '109030', classCode: '103',
        papers: [
          { s: '0201', subject: '生理學與生物化學', tag: 'physio_biochem' },
          { s: '0202', subject: '營養學', tag: 'nutrition_science' },
          { s: '0203', subject: '膳食療養學', tag: 'diet_therapy' },
          { s: '0204', subject: '團體膳食設計與管理', tag: 'group_meal' },
          { s: '0205', subject: '公共衛生營養學', tag: 'public_nutrition' },
          { s: '0206', subject: '食品衛生與安全', tag: 'food_safety' },
        ]
      },
      { year: '109', session: '第二次', code: '109110', classCode: '103',
        papers: [
          { s: '0201', subject: '生理學與生物化學', tag: 'physio_biochem' },
          { s: '0202', subject: '營養學', tag: 'nutrition_science' },
          { s: '0203', subject: '膳食療養學', tag: 'diet_therapy' },
          { s: '0204', subject: '團體膳食設計與管理', tag: 'group_meal' },
          { s: '0205', subject: '公共衛生營養學', tag: 'public_nutrition' },
          { s: '0206', subject: '食品衛生與安全', tag: 'food_safety' },
        ]
      },
    ],
  },
  medlab: {
    file: 'questions-medlab.json',
    classCode: '308',
    papers: [
      { s: '11', subject: '臨床生理學與病理學', tag: 'clinical_physio_path' },
      { s: '22', subject: '臨床血液學與血庫學', tag: 'hematology' },
      { s: '33', subject: '醫學分子檢驗學與臨床鏡檢學', tag: 'molecular' },
      { s: '44', subject: '微生物學與臨床微生物學', tag: 'microbiology' },
      { s: '55', subject: '生物化學與臨床生化學', tag: 'biochemistry' },
      { s: '66', subject: '臨床血清免疫學與臨床病毒學', tag: 'serology' },
    ],
    sessions: [
      { year: '106', session: '第一次', code: '106020' },
      { year: '106', session: '第二次', code: '106100' },
      { year: '107', session: '第一次', code: '107020' },
      { year: '107', session: '第二次', code: '107100' },
      { year: '108', session: '第一次', code: '108030' },
      { year: '108', session: '第二次', code: '108100' },
      { year: '109', session: '第一次', code: '109020' },
      { year: '109', session: '第二次', code: '109100' },
    ],
  },
  ot: {
    file: 'questions-ot.json',
    classCode: '312',
    papers: [
      { s: '11', subject: '解剖學與生理學', tag: 'ot_anatomy' },
      { s: '22', subject: '職能治療學概論', tag: 'ot_intro' },
      { s: '33', subject: '生理疾病職能治療學', tag: 'ot_physical' },
      { s: '44', subject: '心理疾病職能治療學', tag: 'ot_mental' },
      { s: '55', subject: '小兒疾病職能治療學', tag: 'ot_pediatric' },
      { s: '66', subject: '職能治療技術學', tag: 'ot_technique' },
    ],
    sessions: [
      { year: '106', session: '第一次', code: '106020' },
      { year: '106', session: '第二次', code: '106100' },
      { year: '107', session: '第一次', code: '107020' },
      { year: '107', session: '第二次', code: '107100' },
      { year: '108', session: '第一次', code: '108030' },
      { year: '108', session: '第二次', code: '108100' },
      { year: '109', session: '第一次', code: '109020' },
      { year: '109', session: '第二次', code: '109100' },
    ],
  },
  pt: {
    file: 'questions-pt.json',
    classCode: '311',
    papers: [
      { s: '11', subject: '神經疾病物理治療學', tag: 'pt_neuro' },
      { s: '22', subject: '骨科疾病物理治療學', tag: 'pt_ortho' },
      { s: '33', subject: '心肺疾病與小兒疾病物理治療學', tag: 'pt_cardio_peds' },
      { s: '44', subject: '物理治療基礎學', tag: 'pt_basic' },
      { s: '55', subject: '物理治療學概論', tag: 'pt_intro' },
      { s: '66', subject: '物理治療技術學', tag: 'pt_technique' },
    ],
    sessions: [
      { year: '109', session: '第一次', code: '109020' },
    ],
  },
  radiology: {
    file: 'questions-radiology.json',
    classCode: '309',
    papers: [
      { s: '11', subject: '基礎醫學（包括解剖學、生理學與病理學）', tag: 'basic_medicine' },
      { s: '22', subject: '醫學物理學與輻射安全', tag: 'med_physics' },
      { s: '33', subject: '放射線器材學（包括磁振學與超音波學）', tag: 'radio_instruments' },
      { s: '44', subject: '放射線診斷原理與技術學', tag: 'radio_diagnosis' },
      { s: '55', subject: '放射線治療原理與技術學', tag: 'radio_therapy' },
      { s: '66', subject: '核子醫學診療原理與技術學', tag: 'nuclear_medicine' },
    ],
    sessions: [
      { year: '106', session: '第一次', code: '106020' },
      { year: '106', session: '第二次', code: '106100' },
      { year: '107', session: '第一次', code: '107020' },
      { year: '107', session: '第二次', code: '107100' },
      { year: '108', session: '第一次', code: '108030' },
      { year: '108', session: '第二次', code: '108100' },
      { year: '109', session: '第一次', code: '109020' },
      { year: '109', session: '第二次', code: '109100' },
    ],
  },
  tcm1: {
    file: 'questions-tcm1.json',
    classCode: '101',
    papers: [
      { s: '0101', subject: '中醫基礎醫學(一)', tag: 'tcm_basic_1' },
      { s: '0102', subject: '中醫基礎醫學(二)', tag: 'tcm_basic_2' },
    ],
    sessions: [
      { year: '106', session: '第一次', code: '106030' },
      { year: '106', session: '第二次', code: '106110' },
      { year: '107', session: '第一次', code: '107030' },
      { year: '107', session: '第二次', code: '107110' },
      { year: '108', session: '第一次', code: '108020' },
      { year: '108', session: '第二次', code: '108110' },
      { year: '109', session: '第一次', code: '109030' },
      { year: '109', session: '第二次', code: '109110' },
    ],
  },
  tcm2: {
    file: 'questions-tcm2.json',
    classCode: '102',
    papers: [
      { s: '0103', subject: '中醫臨床醫學(一)', tag: 'tcm_clinical_1' },
      { s: '0104', subject: '中醫臨床醫學(二)', tag: 'tcm_clinical_2' },
      { s: '0105', subject: '中醫臨床醫學(三)', tag: 'tcm_clinical_3' },
      { s: '0106', subject: '中醫臨床醫學(四)', tag: 'tcm_clinical_4' },
    ],
    sessions: [
      { year: '106', session: '第一次', code: '106030' },
      { year: '106', session: '第二次', code: '106110' },
      { year: '107', session: '第一次', code: '107030' },
      { year: '107', session: '第二次', code: '107110' },
      { year: '108', session: '第一次', code: '108020' },
      { year: '108', session: '第二次', code: '108110' },
      { year: '109', session: '第一次', code: '109030' },
      { year: '109', session: '第二次', code: '109110' },
    ],
  },
  // customs and police use position-based parser — skip for now, handle separately
}

// ─── HTTP ───

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 20000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*',
                 Referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location
        if (!loc || !loc.startsWith('http')) { res.resume(); return reject(new Error('redirect')) }
        return fetchPdf(loc, retries).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800)
        return reject(new Error('HTTP ' + res.statusCode))
      }
      const ct = res.headers['content-type'] || ''
      if (!ct.includes('pdf') && !ct.includes('octet')) { res.resume(); return reject(new Error('not PDF')) }
      const cs = []
      res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    })
    req.on('error', e => retries > 0
      ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800)
      : reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function buildUrl(type, code, c, s) {
  return `${BASE}?t=${type}&code=${code}&c=${c}&s=${s}&q=1`
}

async function cachedPdf(tag, type, code, c, s) {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const fname = `${tag}_${type}_${code}_c${c}_s${s}.pdf`
  const fpath = path.join(CACHE_DIR, fname)
  if (fs.existsSync(fpath) && fs.statSync(fpath).size > 500) return fs.readFileSync(fpath)
  const buf = await fetchPdf(buildUrl(type, code, c, s))
  fs.writeFileSync(fpath, buf)
  return buf
}

// ─── Non-sequential question parser ───
// Unlike the standard parser, this allows jumping question numbers.
// It returns ALL questions it can find, indexed by number.

function parseQuestionsRelaxed(text) {
  const byNumber = {}
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  let currentQ = null
  let currentOpt = null
  let buffer = ''
  let inMc = false

  const flushOpt = () => {
    if (currentQ && currentOpt) currentQ.options[currentOpt] = buffer.trim()
    buffer = ''; currentOpt = null
  }
  const flushQ = () => {
    flushOpt()
    if (currentQ && currentQ.question && Object.keys(currentQ.options).length >= 2) {
      byNumber[currentQ.number] = currentQ
    }
    currentQ = null
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    // Skip headers/footers
    if (/^(代\s*號|類\s*科|科\s*目|考試|頁次|等\s*別|全.*題|本試題|座號|※|【|】|注意)/.test(line)) continue
    if (/^第?\s*\d+\s*頁/.test(line) || /^\d+\s*頁/.test(line)) continue

    // Detect 測驗題 section marker
    if (/^([一二三四乙貳]、|乙[、.])\s*(測驗|選擇|單選)/.test(line) ||
        (/測驗題|選擇題/.test(line) && !inMc)) {
      flushQ()
      inMc = true
      continue
    }

    // New question — relaxed: allow any number 1-120, not just sequential
    const qm = line.match(/^(\d{1,3})[.、．]\s*(.*)$/)
    if (qm) {
      const num = parseInt(qm[1])
      const rest = (qm[2] || '').trim()
      const looks = rest === '' || /[\u4e00-\u9fff a-zA-Z（(]/.test(rest)
      if (looks && num >= 1 && num <= 120) {
        // Reject if it's a decimal like "1.0 mg"
        if (/^\d+[.]\d/.test(line) && line.length < 8) continue
        flushQ()
        currentQ = { number: num, question: rest, options: {} }
        continue
      }
    }

    // Option line
    const om = line.match(/^[\(（]\s*([A-Da-dＡＢＣＤ])\s*[\)）]\s*(.*)$/)
      || line.match(/^([A-Da-dＡＢＣＤ])\s*[.．、]\s*(.*)$/)
    if (om && currentQ) {
      flushOpt()
      currentOpt = om[1].toUpperCase()
        .replace('Ａ','A').replace('Ｂ','B').replace('Ｃ','C').replace('Ｄ','D')
      buffer = om[2] || ''
      continue
    }

    // Continuation
    if (currentOpt) buffer += ' ' + line
    else if (currentQ) currentQ.question += ' ' + line
  }
  flushQ()
  return byNumber
}

// ─── Answer parser ───

function parseAnswers(text) {
  const answers = {}
  // Method 1: full-width consecutive "答案ＡＣＢＤ..."
  const fw = /答案\s*([ＡＢＣＤ#＃]+)/g
  let m, n = 1
  while ((m = fw.exec(text)) !== null) {
    for (const ch of m[1]) {
      const map = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (map) answers[n++] = map
    }
  }
  if (Object.keys(answers).length >= 10) return answers

  // Method 2: "1.C 2.A" pattern
  const hw = /(\d{1,3})\s*[.、．:：]\s*([A-Da-d])/g
  while ((m = hw.exec(text)) !== null) {
    const num = parseInt(m[1])
    if (num >= 1 && num <= 120) answers[num] = m[2].toUpperCase()
  }
  return answers
}

// ─── Correction parser (t=M) ───

function parseCorrections(text) {
  const corrections = {} // {number: newAnswer}
  const disputed = new Set() // numbers that are 送分
  // Look for "第N題 答案更正為X" or "第N題 一律給分"
  const lines = text.split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    const corrMatch = line.match(/第\s*(\d+)\s*題.*(?:答案|更正).*?([A-DＡＢＣＤa-d])/i)
    if (corrMatch) {
      const num = parseInt(corrMatch[1])
      let ans = corrMatch[2].toUpperCase()
        .replace('Ａ','A').replace('Ｂ','B').replace('Ｃ','C').replace('Ｄ','D')
      corrections[num] = ans
    }
    if (/第\s*(\d+)\s*題.*(?:送分|一律給分|均給分)/.test(line)) {
      const dnum = parseInt(line.match(/第\s*(\d+)\s*題/)[1])
      disputed.add(dnum)
    }
  }
  return { corrections, disputed }
}

const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── Main ───

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const onlyExam = args.find(a => a.startsWith('--exam='))?.slice(7)
    || (args.indexOf('--exam') >= 0 ? args[args.indexOf('--exam') + 1] : null)

  const backendDir = path.join(__dirname, '..')

  // Step 1: Load all question files and find gaps
  let totalRecovered = 0
  let totalImageOnly = 0
  let totalSkipped = 0

  for (const [examId, def] of Object.entries(EXAM_DEFS)) {
    if (onlyExam && examId !== onlyExam) continue

    const filePath = path.join(backendDir, def.file)
    if (!fs.existsSync(filePath)) {
      console.log(`⚠ ${examId}: file ${def.file} not found, skipping`)
      continue
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const questions = data.questions || []
    const existingByKey = new Map()
    questions.forEach(q => {
      const key = `${q.roc_year}|${q.session}|${q.subject}|${q.number}`
      existingByKey.set(key, q)
    })
    let nextId = questions.reduce((m, q) => Math.max(m, parseInt(q.id) || 0), 0) + 1
    const newQs = []

    // Build session list: merge standard + old sessions
    const allSessions = []
    for (const sess of (def.sessions || [])) {
      allSessions.push({
        ...sess,
        classCode: def.classCode,
        papers: def.papers,
      })
    }
    for (const sess of (def.oldSessions || [])) {
      allSessions.push(sess)
    }

    // For each session, check each paper for missing question numbers
    for (const sess of allSessions) {
      for (const paper of sess.papers) {
        // Find which question numbers are missing
        const existingNumbers = new Set()
        let maxExpected = 0
        for (const q of questions) {
          if (String(q.roc_year) === sess.year && q.session === sess.session && q.subject === paper.subject) {
            existingNumbers.add(q.number)
            maxExpected = Math.max(maxExpected, q.number)
          }
        }
        if (maxExpected === 0) continue // no questions at all for this session/paper → not our problem

        const missing = []
        for (let i = 1; i <= maxExpected; i++) {
          if (!existingNumbers.has(i)) missing.push(i)
        }
        if (missing.length === 0) continue

        if (dryRun) {
          console.log(`${examId} ${sess.year}/${sess.session} ${paper.subject}: missing [${missing.join(',')}] (${missing.length} 題)`)
          totalSkipped += missing.length
          continue
        }

        // Download PDFs
        console.log(`\n--- ${examId} ${sess.year}/${sess.session} ${paper.subject} ---`)
        console.log(`  缺題: [${missing.join(',')}]`)

        let qBuf, aBuf, mBuf
        try {
          qBuf = await cachedPdf(`${examId}_${sess.year}${sess.session}`, 'Q', sess.code, sess.classCode, paper.s)
        } catch (e) {
          console.log(`  ✗ 試題 PDF 下載失敗: ${e.message}`)
          totalSkipped += missing.length
          continue
        }
        try {
          aBuf = await cachedPdf(`${examId}_${sess.year}${sess.session}`, 'S', sess.code, sess.classCode, paper.s)
        } catch (e) {
          console.log(`  ✗ 答案 PDF 下載失敗: ${e.message}`)
          totalSkipped += missing.length
          continue
        }
        try {
          mBuf = await cachedPdf(`${examId}_${sess.year}${sess.session}`, 'M', sess.code, sess.classCode, paper.s)
        } catch { /* corrections PDF often doesn't exist — that's ok */ }

        // Parse
        const qText = (await pdfParse(qBuf)).text
        const aText = (await pdfParse(aBuf)).text
        const parsed = parseQuestionsRelaxed(qText)
        const answers = parseAnswers(aText)
        let corrections = {}, disputed = new Set()
        if (mBuf) {
          const mText = (await pdfParse(mBuf)).text
          const c = parseCorrections(mText)
          corrections = c.corrections
          disputed = c.disputed
        }

        // Fill gaps
        let recovered = 0, imageOnly = 0
        for (const num of missing) {
          const answer = corrections[num] || answers[num]
          const isDisputed = disputed.has(num)
          const parsedQ = parsed[num]

          if (!answer && !parsedQ) {
            console.log(`  ⚠ #${num}: 題目+答案都無法解析，跳過`)
            totalSkipped++
            continue
          }

          const q = {
            id: String(nextId++),
            roc_year: sess.year,
            session: sess.session,
            exam_code: sess.code,
            subject: paper.subject,
            subject_tag: paper.tag,
            subject_name: paper.subject,
            stage_id: 0,
            number: num,
            question: parsedQ ? stripPUA(parsedQ.question) : '（本題含圖片，請參考原始試卷）',
            options: parsedQ
              ? Object.fromEntries(Object.entries(parsedQ.options).map(([k, v]) => [k, stripPUA(v)]))
              : { A: '', B: '', C: '', D: '' },
            answer: answer || 'A',
          }
          if (isDisputed) q.disputed = true
          if (!parsedQ) {
            q.image_only = true
            imageOnly++
          } else {
            recovered++
          }
          newQs.push(q)
        }
        if (recovered || imageOnly)
          console.log(`  → 補回 ${recovered} 題` + (imageOnly ? `, ${imageOnly} 題為圖片題(僅答案)` : ''))

        await sleep(300) // be nice to MoEX
      }
    }

    if (newQs.length > 0) {
      questions.push(...newQs)
      data.questions = questions
      data.total = questions.length
      const tmp = filePath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
      fs.renameSync(tmp, filePath)
      console.log(`\n✓ ${examId}: 共補 ${newQs.length} 題，寫入 ${def.file} (total: ${data.total})`)
      totalRecovered += newQs.length
    }
  }

  console.log(`\n========================================`)
  if (dryRun) {
    console.log(`DRY RUN: 共 ${totalSkipped} 題可嘗試補回`)
  } else {
    console.log(`完成: 補回 ${totalRecovered} 題, 圖片題 ${totalImageOnly} 題, 跳過 ${totalSkipped} 題`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
