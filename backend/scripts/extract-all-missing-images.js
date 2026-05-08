#!/usr/bin/env node
/**
 * extract-all-missing-images.js
 *
 * Runs extractPaper() for every (exam_code, class_code, subject_code) combination
 * that has gap_reason="missing_image_dep" questions. On success, links the extracted
 * image URLs back into the JSON files and removes incomplete/gap_reason flags.
 *
 * Usage:
 *   node scripts/extract-all-missing-images.js             # all exams
 *   node scripts/extract-all-missing-images.js --dry-run   # skip disk writes
 *   node scripts/extract-all-missing-images.js --exam medlab  # one exam
 */

const fs = require('fs')
const path = require('path')
const { extractPaper } = require('./extract-images-v3')

const BACKEND = path.join(__dirname, '..')
const dryRun = process.argv.includes('--dry-run')
const examFilter = (() => {
  const a = process.argv.find(x => x.startsWith('--exam='))
  return a ? a.split('=')[1] : null
})()

// ─── Paper configurations ───────────────────────────────────────────��──────
// Each entry: one PDF to extract images from.
// { exam, file, code, c, s, pi, year, session, subject }
//   exam    = examId used in image filename prefix
//   file    = questions JSON filename in backend/
//   code    = 考選部 exam code
//   c       = class code
//   s       = subject code
//   pi      = paperIdx (unique per code to avoid filename collisions)
//   year    = ROC year string (matches q.roc_year)
//   session = 第一次 | 第二次
//   subject = matches q.subject exactly

const PAPERS = [
  // ── DOCTOR1 ──────────────────────────────────────────────────────────────
  // Years 100-104: c=101, s=0102 (醫學二 — only paper with image-dep questions)
  { exam:'doctor1', file:'questions.json', code:'101030', c:'101', s:'0102', pi:1, year:'101', session:'第一次', subject:'醫學(二)' },
  { exam:'doctor1', file:'questions.json', code:'101110', c:'101', s:'0102', pi:1, year:'101', session:'第二次', subject:'醫學(二)' },
  { exam:'doctor1', file:'questions.json', code:'102110', c:'101', s:'0102', pi:1, year:'102', session:'第二次', subject:'醫學(二)' },
  { exam:'doctor1', file:'questions.json', code:'104030', c:'101', s:'0102', pi:1, year:'104', session:'第一次', subject:'醫學(二)' },

  // ── DOCTOR2 ──────────────────────────────────────────────────────────────
  // 100-103: c=102, s=0103-0106
  { exam:'doctor2', file:'questions-doctor2.json', code:'100030', c:'102', s:'0104', pi:1, year:'100', session:'第一次', subject:'醫學(四)' },
  { exam:'doctor2', file:'questions-doctor2.json', code:'102030', c:'102', s:'0103', pi:0, year:'102', session:'第一次', subject:'醫學(三)' },
  { exam:'doctor2', file:'questions-doctor2.json', code:'103030', c:'102', s:'0103', pi:0, year:'103', session:'第一次', subject:'醫學(三)' },
  { exam:'doctor2', file:'questions-doctor2.json', code:'103030', c:'102', s:'0104', pi:1, year:'103', session:'第一次', subject:'醫學(四)' },
  { exam:'doctor2', file:'questions-doctor2.json', code:'103100', c:'102', s:'0104', pi:1, year:'103', session:'第二次', subject:'醫學(四)' },
  { exam:'doctor2', file:'questions-doctor2.json', code:'103100', c:'102', s:'0106', pi:3, year:'103', session:'第二次', subject:'醫學(六)' },
  // 104-105: c=302 020-series, s=11/22/33/44
  { exam:'doctor2', file:'questions-doctor2.json', code:'104090', c:'302', s:'44',   pi:3, year:'104', session:'第二次', subject:'醫學(六)' },
  { exam:'doctor2', file:'questions-doctor2.json', code:'105020', c:'302', s:'22',   pi:1, year:'105', session:'第一次', subject:'醫學(四)' },
  // 106+: c=302, s=11/22/33/44
  { exam:'doctor2', file:'questions-doctor2.json', code:'106020', c:'302', s:'11',   pi:0, year:'106', session:'第一次', subject:'醫學(三)' },
  { exam:'doctor2', file:'questions-doctor2.json', code:'106080', c:'302', s:'22',   pi:1, year:'106', session:'第二次', subject:'醫學(四)' },
  { exam:'doctor2', file:'questions-doctor2.json', code:'106080', c:'302', s:'33',   pi:2, year:'106', session:'第二次', subject:'醫學(五)' },
  { exam:'doctor2', file:'questions-doctor2.json', code:'107080', c:'302', s:'11',   pi:0, year:'107', session:'第二次', subject:'醫學(三)' },
  { exam:'doctor2', file:'questions-doctor2.json', code:'111080', c:'302', s:'33',   pi:2, year:'111', session:'第二次', subject:'醫學(五)' },
  { exam:'doctor2', file:'questions-doctor2.json', code:'113070', c:'302', s:'22',   pi:1, year:'113', session:'第二次', subject:'醫學(四)' },
  { exam:'doctor2', file:'questions-doctor2.json', code:'115020', c:'302', s:'44',   pi:3, year:'115', session:'第一次', subject:'醫學(六)' },

  // ── MEDLAB ────────────────────────────────────────────────────────────────
  // 030-series (100-101): c=104, s=0107/0301/0302/0303/0304/0305
  { exam:'medlab', file:'questions-medlab.json', code:'100030', c:'104', s:'0107', pi:0, year:'100', session:'第一次', subject:'臨床生理學與病理學' },
  { exam:'medlab', file:'questions-medlab.json', code:'100140', c:'104', s:'0302', pi:2, year:'100', session:'第二次', subject:'醫學分子檢驗學與臨床鏡檢學' },
  { exam:'medlab', file:'questions-medlab.json', code:'101030', c:'104', s:'0107', pi:0, year:'101', session:'第一次', subject:'臨床生理學與病理學' },
  { exam:'medlab', file:'questions-medlab.json', code:'101030', c:'104', s:'0301', pi:1, year:'101', session:'第一次', subject:'臨床血液學與血庫學' },
  { exam:'medlab', file:'questions-medlab.json', code:'101030', c:'104', s:'0302', pi:2, year:'101', session:'第一次', subject:'醫學分子檢驗學與臨床鏡檢學' },
  // 020-series (102-104): c=311, s=11-66
  { exam:'medlab', file:'questions-medlab.json', code:'102100', c:'311', s:'11',   pi:0, year:'102', session:'第二次', subject:'臨床生理學與病理學' },
  { exam:'medlab', file:'questions-medlab.json', code:'102100', c:'311', s:'22',   pi:1, year:'102', session:'第二次', subject:'臨床血液學與血庫學' },
  { exam:'medlab', file:'questions-medlab.json', code:'103020', c:'311', s:'22',   pi:1, year:'103', session:'第一次', subject:'臨床血液學與血庫學' },
  { exam:'medlab', file:'questions-medlab.json', code:'103020', c:'311', s:'55',   pi:4, year:'103', session:'第一次', subject:'生物化學與臨床生化學' },
  { exam:'medlab', file:'questions-medlab.json', code:'103090', c:'311', s:'11',   pi:0, year:'103', session:'第二次', subject:'臨床生理學與病理學' },
  { exam:'medlab', file:'questions-medlab.json', code:'103090', c:'311', s:'22',   pi:1, year:'103', session:'第二次', subject:'臨床血液學與血庫學' },
  { exam:'medlab', file:'questions-medlab.json', code:'104020', c:'311', s:'11',   pi:0, year:'104', session:'第一次', subject:'臨床生理學與病理學' },
  { exam:'medlab', file:'questions-medlab.json', code:'104020', c:'311', s:'22',   pi:1, year:'104', session:'第一次', subject:'臨床血液學與血庫學' },
  { exam:'medlab', file:'questions-medlab.json', code:'104020', c:'311', s:'66',   pi:5, year:'104', session:'第一次', subject:'臨床血清免疫學與臨床病毒學' },
  // 020-series (104-105): c=308, s=11-66
  { exam:'medlab', file:'questions-medlab.json', code:'104090', c:'308', s:'11',   pi:0, year:'104', session:'第二次', subject:'臨床生理學與病理學' },
  { exam:'medlab', file:'questions-medlab.json', code:'104090', c:'308', s:'55',   pi:4, year:'104', session:'第二次', subject:'生物化學與臨床生化學' },
  { exam:'medlab', file:'questions-medlab.json', code:'105020', c:'308', s:'11',   pi:0, year:'105', session:'第一次', subject:'臨床生理學與病理學' },
  { exam:'medlab', file:'questions-medlab.json', code:'105020', c:'308', s:'22',   pi:1, year:'105', session:'第一次', subject:'臨床血液學與血庫學' },
  { exam:'medlab', file:'questions-medlab.json', code:'105020', c:'308', s:'66',   pi:5, year:'105', session:'第一次', subject:'臨床血清免疫學與臨床病毒學' },
  { exam:'medlab', file:'questions-medlab.json', code:'105100', c:'308', s:'11',   pi:0, year:'105', session:'第二次', subject:'臨床生理學與病理學' },
  { exam:'medlab', file:'questions-medlab.json', code:'105100', c:'308', s:'22',   pi:1, year:'105', session:'第二次', subject:'臨床血液學與血庫學' },
  // 106+: c=308, s=11-66
  { exam:'medlab', file:'questions-medlab.json', code:'106020', c:'308', s:'11',   pi:0, year:'106', session:'第一次', subject:'臨床生理學與病理學' },
  { exam:'medlab', file:'questions-medlab.json', code:'106020', c:'308', s:'22',   pi:1, year:'106', session:'第一次', subject:'臨床血液學與血庫學' },
  { exam:'medlab', file:'questions-medlab.json', code:'106100', c:'308', s:'11',   pi:0, year:'106', session:'第二次', subject:'臨床生理學與病理學' },
  { exam:'medlab', file:'questions-medlab.json', code:'106100', c:'308', s:'22',   pi:1, year:'106', session:'第二次', subject:'臨床血液學與血庫學' },
  { exam:'medlab', file:'questions-medlab.json', code:'107020', c:'308', s:'11',   pi:0, year:'107', session:'第一次', subject:'臨床生理學與病理學' },
  { exam:'medlab', file:'questions-medlab.json', code:'107020', c:'308', s:'33',   pi:2, year:'107', session:'第一次', subject:'醫學分子檢驗學與臨床鏡檢學' },
  { exam:'medlab', file:'questions-medlab.json', code:'107100', c:'308', s:'11',   pi:0, year:'107', session:'第二次', subject:'臨床生理學與病理學' },
  { exam:'medlab', file:'questions-medlab.json', code:'108030', c:'308', s:'22',   pi:1, year:'108', session:'第一次', subject:'臨床血液學與血庫學' },
  { exam:'medlab', file:'questions-medlab.json', code:'108100', c:'308', s:'11',   pi:0, year:'108', session:'第二次', subject:'臨床生理學與病理學' },
  { exam:'medlab', file:'questions-medlab.json', code:'108100', c:'308', s:'22',   pi:1, year:'108', session:'第二次', subject:'臨床血液學與血庫學' },
  { exam:'medlab', file:'questions-medlab.json', code:'109020', c:'308', s:'11',   pi:0, year:'109', session:'第一次', subject:'臨床生理學與病理學' },
  { exam:'medlab', file:'questions-medlab.json', code:'109100', c:'308', s:'11',   pi:0, year:'109', session:'第二次', subject:'臨床生理學與病理學' },
  { exam:'medlab', file:'questions-medlab.json', code:'109100', c:'308', s:'22',   pi:1, year:'109', session:'第二次', subject:'臨床血液學與血庫學' },
  { exam:'medlab', file:'questions-medlab.json', code:'109100', c:'308', s:'33',   pi:2, year:'109', session:'第二次', subject:'醫學分子檢驗學與臨床鏡檢學' },
  { exam:'medlab', file:'questions-medlab.json', code:'110020', c:'308', s:'44',   pi:3, year:'110', session:'第一次', subject:'微生物學與臨床微生物學' },
  { exam:'medlab', file:'questions-medlab.json', code:'110100', c:'308', s:'11',   pi:0, year:'110', session:'第二次', subject:'臨床生理學與病理學' },
  { exam:'medlab', file:'questions-medlab.json', code:'111020', c:'308', s:'11',   pi:0, year:'111', session:'第一次', subject:'臨床生理學與病理學' },
  { exam:'medlab', file:'questions-medlab.json', code:'111020', c:'308', s:'33',   pi:2, year:'111', session:'第一次', subject:'醫學分子檢驗學與臨床鏡檢學' },
  { exam:'medlab', file:'questions-medlab.json', code:'111100', c:'308', s:'11',   pi:0, year:'111', session:'第二次', subject:'臨床生理學與病理學' },
  { exam:'medlab', file:'questions-medlab.json', code:'112020', c:'308', s:'11',   pi:0, year:'112', session:'第一次', subject:'臨床生理學與病理學' },
  { exam:'medlab', file:'questions-medlab.json', code:'112020', c:'308', s:'22',   pi:1, year:'112', session:'第一次', subject:'臨床血液學與血庫學' },
  { exam:'medlab', file:'questions-medlab.json', code:'112020', c:'308', s:'33',   pi:2, year:'112', session:'第一次', subject:'醫學分子檢驗學與臨床鏡檢學' },
  { exam:'medlab', file:'questions-medlab.json', code:'113020', c:'308', s:'11',   pi:0, year:'113', session:'第一次', subject:'臨床生理學與病理學' },
  { exam:'medlab', file:'questions-medlab.json', code:'113020', c:'308', s:'22',   pi:1, year:'113', session:'第一次', subject:'臨床血液學與血庫學' },
  { exam:'medlab', file:'questions-medlab.json', code:'113020', c:'308', s:'33',   pi:2, year:'113', session:'第一次', subject:'醫學分子檢驗學與臨床鏡檢學' },
  { exam:'medlab', file:'questions-medlab.json', code:'115020', c:'308', s:'55',   pi:4, year:'115', session:'第一次', subject:'生物化學與臨床生化學' },

  // ── RADIOLOGY ─────────────────────────────────────────────────────────────
  // Subject s codes (s=11-66 for all radiology):
  //   s=11: 基礎醫學（包括解剖學、生理學與病理學）  pi=0
  //   s=22: 醫學物理學與輻射安全                   pi=1
  //   s=33: 放射線器材學（包括磁振學與超音波學）    pi=2
  //   s=44: 放射線診斷原理與技術學                  pi=3
  //   s=55: 放射線治療原理與技術學                  pi=4
  //   s=66: 核子醫學診療原理與技術學               pi=5
  // 100-104: c=308; 104090+: c=309
  { exam:'radiology', file:'questions-radiology.json', code:'100130', c:'308', s:'33',   pi:2, year:'100', session:'第二次', subject:'放射線器材學（包括磁振學與超音波學）' },
  { exam:'radiology', file:'questions-radiology.json', code:'101010', c:'308', s:'44',   pi:3, year:'101', session:'第一次', subject:'放射線診斷原理與技術學' },
  { exam:'radiology', file:'questions-radiology.json', code:'101100', c:'308', s:'44',   pi:3, year:'101', session:'第二次', subject:'放射線診斷原理與技術學' },
  { exam:'radiology', file:'questions-radiology.json', code:'102020', c:'308', s:'44',   pi:3, year:'102', session:'第一次', subject:'放射線診斷原理與技術學' },
  { exam:'radiology', file:'questions-radiology.json', code:'102020', c:'308', s:'55',   pi:4, year:'102', session:'第一次', subject:'放射線治療原理與技術學' },
  { exam:'radiology', file:'questions-radiology.json', code:'102100', c:'308', s:'22',   pi:1, year:'102', session:'第二次', subject:'醫學物理學與輻射安全' },
  { exam:'radiology', file:'questions-radiology.json', code:'102100', c:'308', s:'44',   pi:3, year:'102', session:'第二次', subject:'放射線診斷原理與技術學' },
  { exam:'radiology', file:'questions-radiology.json', code:'103020', c:'308', s:'22',   pi:1, year:'103', session:'第一次', subject:'醫學物理學與輻射安全' },
  { exam:'radiology', file:'questions-radiology.json', code:'103020', c:'308', s:'44',   pi:3, year:'103', session:'第一次', subject:'放射線診斷原理與技術學' },
  { exam:'radiology', file:'questions-radiology.json', code:'103090', c:'308', s:'44',   pi:3, year:'103', session:'第二次', subject:'放射線診斷原理與技術學' },
  { exam:'radiology', file:'questions-radiology.json', code:'104020', c:'308', s:'44',   pi:3, year:'104', session:'第一次', subject:'放射線診斷原理與技術學' },
  { exam:'radiology', file:'questions-radiology.json', code:'104090', c:'309', s:'11',   pi:0, year:'104', session:'第二次', subject:'基礎醫學（包括解剖學、生理學與病理學）' },
  { exam:'radiology', file:'questions-radiology.json', code:'104090', c:'309', s:'44',   pi:3, year:'104', session:'第二次', subject:'放射線診斷原理與技術學' },
  { exam:'radiology', file:'questions-radiology.json', code:'105020', c:'309', s:'22',   pi:1, year:'105', session:'第一次', subject:'醫學物理學與輻射安全' },
  { exam:'radiology', file:'questions-radiology.json', code:'105020', c:'309', s:'44',   pi:3, year:'105', session:'第一次', subject:'放射線診斷原理與技術學' },
  { exam:'radiology', file:'questions-radiology.json', code:'105100', c:'309', s:'33',   pi:2, year:'105', session:'第二次', subject:'放射線器材學（包括磁振學與超音波學）' },
  { exam:'radiology', file:'questions-radiology.json', code:'105100', c:'309', s:'44',   pi:3, year:'105', session:'第二次', subject:'放射線診斷原理與技術學' },
  // 106+: c=309, s=11-66
  { exam:'radiology', file:'questions-radiology.json', code:'106020', c:'309', s:'11',   pi:0, year:'106', session:'第一次', subject:'基礎醫學（包括解剖學、生理學與病理學）' },
  { exam:'radiology', file:'questions-radiology.json', code:'106100', c:'309', s:'44',   pi:3, year:'106', session:'第二次', subject:'放射線診斷原理與技術學' },
  { exam:'radiology', file:'questions-radiology.json', code:'107020', c:'309', s:'22',   pi:1, year:'107', session:'第一次', subject:'醫學物理學與輻射安全' },
  { exam:'radiology', file:'questions-radiology.json', code:'107020', c:'309', s:'44',   pi:3, year:'107', session:'第一次', subject:'放射線診斷原理與技術學' },
  { exam:'radiology', file:'questions-radiology.json', code:'107020', c:'309', s:'33',   pi:2, year:'107', session:'第一次', subject:'放射線器材學（包括磁振學與超音波學）' },
  { exam:'radiology', file:'questions-radiology.json', code:'107020', c:'309', s:'55',   pi:4, year:'107', session:'第一次', subject:'放射線治療原理與技術學' },
  { exam:'radiology', file:'questions-radiology.json', code:'107020', c:'309', s:'66',   pi:5, year:'107', session:'第一次', subject:'核子醫學診療原理與技術學' },
  { exam:'radiology', file:'questions-radiology.json', code:'107100', c:'309', s:'44',   pi:3, year:'107', session:'第二次', subject:'放射線診斷原理與技術學' },
  { exam:'radiology', file:'questions-radiology.json', code:'107100', c:'309', s:'55',   pi:4, year:'107', session:'第二次', subject:'放射線治療原理與技術學' },
  { exam:'radiology', file:'questions-radiology.json', code:'108030', c:'309', s:'66',   pi:5, year:'108', session:'第一次', subject:'核子醫學診療原理與技術學' },
  { exam:'radiology', file:'questions-radiology.json', code:'109020', c:'309', s:'66',   pi:5, year:'109', session:'第一次', subject:'核子醫學診療原理與技術學' },
  { exam:'radiology', file:'questions-radiology.json', code:'109020', c:'309', s:'33',   pi:2, year:'109', session:'第一次', subject:'放射線器材學（包括磁振學與超音波學）' },
  { exam:'radiology', file:'questions-radiology.json', code:'110100', c:'309', s:'33',   pi:2, year:'110', session:'第二次', subject:'放射線器材學（包括磁振學與超音波學）' },
  { exam:'radiology', file:'questions-radiology.json', code:'111020', c:'309', s:'66',   pi:5, year:'111', session:'第一次', subject:'核子醫學診療原理與技術學' },
  { exam:'radiology', file:'questions-radiology.json', code:'111020', c:'309', s:'55',   pi:4, year:'111', session:'第一次', subject:'放射線治療原理與技術學' },
  { exam:'radiology', file:'questions-radiology.json', code:'111100', c:'309', s:'44',   pi:3, year:'111', session:'第二次', subject:'放射線診斷原理與技術學' },
  { exam:'radiology', file:'questions-radiology.json', code:'112020', c:'309', s:'33',   pi:2, year:'112', session:'第一次', subject:'放射線器材學（包括磁振學與超音波學）' },
  { exam:'radiology', file:'questions-radiology.json', code:'112100', c:'309', s:'44',   pi:3, year:'112', session:'第二次', subject:'放射線診斷原理與技術學' },
  { exam:'radiology', file:'questions-radiology.json', code:'113020', c:'309', s:'66',   pi:5, year:'113', session:'第一次', subject:'核子醫學診療原理與技術學' },

  // ── PHYSICAL THERAPY (PT) ─────────────────────────────────────────────────
  // s=11: 物理治療基礎學 pi=0; s=22: 物理治療學概論 pi=1; s=33: 物理治療技術學 pi=2
  // s=44: 神經疾病 pi=3; s=55: 骨科疾病 pi=4; s=66: 心肺疾病與小兒 pi=5
  // 100030: c=106, s=0501-0506
  { exam:'pt', file:'questions-pt.json', code:'100030', c:'106', s:'0501', pi:0, year:'100', session:'第一次', subject:'物理治療基礎學' },
  { exam:'pt', file:'questions-pt.json', code:'100030', c:'106', s:'0503', pi:2, year:'100', session:'第一次', subject:'物理治療技術學' },
  { exam:'pt', file:'questions-pt.json', code:'100030', c:'106', s:'0506', pi:5, year:'100', session:'第一次', subject:'心肺疾病與小兒疾病物理治療學' },
  // 102020-104020: c=309
  { exam:'pt', file:'questions-pt.json', code:'102020', c:'309', s:'11',   pi:0, year:'102', session:'第一次', subject:'物理治療基礎學' },
  { exam:'pt', file:'questions-pt.json', code:'104020', c:'309', s:'33',   pi:2, year:'104', session:'第一次', subject:'物理治療技術學' },
  // 105: c=311
  { exam:'pt', file:'questions-pt.json', code:'105020', c:'311', s:'33',   pi:2, year:'105', session:'第一次', subject:'物理治療技術學' },
  { exam:'pt', file:'questions-pt.json', code:'105100', c:'311', s:'55',   pi:4, year:'105', session:'第二次', subject:'骨科疾病物理治療學' },
  // 106+: c=311
  { exam:'pt', file:'questions-pt.json', code:'106020', c:'311', s:'66',   pi:5, year:'106', session:'第一次', subject:'心肺疾病與小兒疾病物理治療學' },
  { exam:'pt', file:'questions-pt.json', code:'109020', c:'311', s:'44',   pi:3, year:'109', session:'第一次', subject:'神經疾病物理治療學' },
  { exam:'pt', file:'questions-pt.json', code:'110020', c:'311', s:'44',   pi:3, year:'110', session:'第一次', subject:'神經疾病物理治療學' },
  { exam:'pt', file:'questions-pt.json', code:'110101', c:'311', s:'11',   pi:0, year:'110', session:'第二次', subject:'物理治療基礎學' },
  { exam:'pt', file:'questions-pt.json', code:'111100', c:'311', s:'22',   pi:1, year:'111', session:'第二次', subject:'物理治療學概論' },
  { exam:'pt', file:'questions-pt.json', code:'114020', c:'311', s:'22',   pi:1, year:'114', session:'第一次', subject:'物理治療學概論' },
  { exam:'pt', file:'questions-pt.json', code:'115020', c:'311', s:'33',   pi:2, year:'115', session:'第一次', subject:'物理治療技術學' },

  // ── OCCUPATIONAL THERAPY (OT) ─────────────────────────────────────────────
  // s=11: 解剖學與生理學 pi=0; s=66: 職能治療技術學 pi=5; s=33: 生理疾病 pi=2
  // 100-104: c=305; 105+: c=312
  { exam:'ot', file:'questions-ot.json', code:'100130', c:'305', s:'66',   pi:5, year:'100', session:'第二次', subject:'職能治療技術學' },
  { exam:'ot', file:'questions-ot.json', code:'101010', c:'305', s:'66',   pi:5, year:'101', session:'第一次', subject:'職能治療技術學' },
  { exam:'ot', file:'questions-ot.json', code:'101100', c:'305', s:'11',   pi:0, year:'101', session:'第二次', subject:'解剖學與生理學' },
  { exam:'ot', file:'questions-ot.json', code:'102020', c:'305', s:'66',   pi:5, year:'102', session:'第一次', subject:'職能治療技術學' },
  { exam:'ot', file:'questions-ot.json', code:'105020', c:'312', s:'11',   pi:0, year:'105', session:'第一次', subject:'解剖學與生理學' },
  { exam:'ot', file:'questions-ot.json', code:'106020', c:'312', s:'11',   pi:0, year:'106', session:'第一次', subject:'解剖學與生理學' },
  { exam:'ot', file:'questions-ot.json', code:'107100', c:'312', s:'66',   pi:5, year:'107', session:'第二次', subject:'職能治療技術學' },
  { exam:'ot', file:'questions-ot.json', code:'112100', c:'312', s:'66',   pi:5, year:'112', session:'第二次', subject:'職能治療技術學' },
  { exam:'ot', file:'questions-ot.json', code:'113090', c:'312', s:'33',   pi:2, year:'113', session:'第二次', subject:'生理疾病職能治療學' },
  { exam:'ot', file:'questions-ot.json', code:'113090', c:'312', s:'66',   pi:5, year:'113', session:'第二次', subject:'職能治療技術學' },

  // ── DENTAL1 ───────────────────────────────────────────────────────────────
  // s=11: 卷一 pi=0; s=22: 卷二 pi=1
  // 100-104030: c=301; 104090+: c=303
  // 114+: c=303, s=0201(卷一)/0202(卷二)
  { exam:'dental1', file:'questions-dental1.json', code:'105020', c:'303', s:'22',   pi:1, year:'105', session:'第一次', subject:'卷二' },
  { exam:'dental1', file:'questions-dental1.json', code:'105100', c:'303', s:'22',   pi:1, year:'105', session:'第二次', subject:'卷二' },
  { exam:'dental1', file:'questions-dental1.json', code:'106100', c:'303', s:'11',   pi:0, year:'106', session:'第二次', subject:'卷一' },
  { exam:'dental1', file:'questions-dental1.json', code:'107100', c:'303', s:'11',   pi:0, year:'107', session:'第二次', subject:'卷一' },
  { exam:'dental1', file:'questions-dental1.json', code:'109020', c:'303', s:'22',   pi:1, year:'109', session:'第一次', subject:'卷二' },
  { exam:'dental1', file:'questions-dental1.json', code:'110101', c:'303', s:'22',   pi:1, year:'110', session:'第二次', subject:'卷二' },

  // ── DENTAL2 ───────────────────────────────────────────────────────────────
  // s=33: 卷一 pi=0; s=44: 卷二 pi=1; s=55: 卷三 pi=2; s=66: 卷四 pi=3
  // 100-103: c=302; 104090+: c=304
  // 114+: c=304, s=0203(卷一)/0204(卷二)/0205(卷三)/0206(卷四)
  { exam:'dental2', file:'questions-dental2.json', code:'100020', c:'302', s:'44',   pi:1, year:'100', session:'第一次', subject:'卷二' },
  { exam:'dental2', file:'questions-dental2.json', code:'100130', c:'302', s:'44',   pi:1, year:'100', session:'第二次', subject:'卷二' },
  { exam:'dental2', file:'questions-dental2.json', code:'101010', c:'302', s:'44',   pi:1, year:'101', session:'第一次', subject:'卷二' },
  { exam:'dental2', file:'questions-dental2.json', code:'101100', c:'302', s:'55',   pi:2, year:'101', session:'第二次', subject:'卷三' },
  { exam:'dental2', file:'questions-dental2.json', code:'102020', c:'302', s:'44',   pi:1, year:'102', session:'第一次', subject:'卷二' },
  { exam:'dental2', file:'questions-dental2.json', code:'103020', c:'302', s:'44',   pi:1, year:'103', session:'第一次', subject:'卷二' },
  { exam:'dental2', file:'questions-dental2.json', code:'103090', c:'302', s:'44',   pi:1, year:'103', session:'第二次', subject:'卷二' },
  { exam:'dental2', file:'questions-dental2.json', code:'103090', c:'302', s:'55',   pi:2, year:'103', session:'第二次', subject:'卷三' },
  // 106+: c=304
  { exam:'dental2', file:'questions-dental2.json', code:'106020', c:'304', s:'33',   pi:0, year:'106', session:'第一次', subject:'卷一' },
  { exam:'dental2', file:'questions-dental2.json', code:'106020', c:'304', s:'44',   pi:1, year:'106', session:'第一次', subject:'卷二' },
  { exam:'dental2', file:'questions-dental2.json', code:'108030', c:'304', s:'44',   pi:1, year:'108', session:'第一次', subject:'卷二' },
  { exam:'dental2', file:'questions-dental2.json', code:'108100', c:'304', s:'44',   pi:1, year:'108', session:'第二次', subject:'卷二' },
  { exam:'dental2', file:'questions-dental2.json', code:'109020', c:'304', s:'44',   pi:1, year:'109', session:'第一次', subject:'卷二' },
  { exam:'dental2', file:'questions-dental2.json', code:'109100', c:'304', s:'44',   pi:1, year:'109', session:'第二次', subject:'卷二' },
  { exam:'dental2', file:'questions-dental2.json', code:'110100', c:'304', s:'44',   pi:1, year:'110', session:'第二次', subject:'卷二' },
  { exam:'dental2', file:'questions-dental2.json', code:'111020', c:'304', s:'66',   pi:3, year:'111', session:'第一次', subject:'卷四' },
  { exam:'dental2', file:'questions-dental2.json', code:'111100', c:'304', s:'66',   pi:3, year:'111', session:'第二次', subject:'卷四' },
  { exam:'dental2', file:'questions-dental2.json', code:'112020', c:'304', s:'66',   pi:3, year:'112', session:'第一次', subject:'卷四' },
  { exam:'dental2', file:'questions-dental2.json', code:'113020', c:'304', s:'66',   pi:3, year:'113', session:'第一次', subject:'卷四' },
  // 115: c=304, s=0203(卷一)/0206(卷四)
  { exam:'dental2', file:'questions-dental2.json', code:'115020', c:'304', s:'0203', pi:0, year:'115', session:'第一次', subject:'卷一' },
  { exam:'dental2', file:'questions-dental2.json', code:'115020', c:'304', s:'0206', pi:3, year:'115', session:'第一次', subject:'卷四' },

  // ── VETERINARY (VET) ──────────────────────────────────────────────────────
  // s=11: 獸醫病理學 pi=0; s=22: 獸醫藥理學 pi=1; s=33: 獸醫實驗診斷學 pi=2
  // s=44: 獸醫普通疾病學 pi=3; s=55: 獸醫傳染病學 pi=4; s=66: 獸醫公共衛生學 pi=5
  // 106-113: c=314, s=11-66; 114: c=314, s=1001-1006
  { exam:'vet', file:'questions-vet.json', code:'106020', c:'314', s:'44',   pi:3, year:'106', session:'第一次', subject:'獸醫普通疾病學' },
  { exam:'vet', file:'questions-vet.json', code:'106100', c:'314', s:'55',   pi:4, year:'106', session:'第二次', subject:'獸醫傳染病學' },
  { exam:'vet', file:'questions-vet.json', code:'107020', c:'314', s:'22',   pi:1, year:'107', session:'第一次', subject:'獸醫藥理學' },
  { exam:'vet', file:'questions-vet.json', code:'107100', c:'314', s:'11',   pi:0, year:'107', session:'第二次', subject:'獸醫病理學' },
  { exam:'vet', file:'questions-vet.json', code:'107100', c:'314', s:'44',   pi:3, year:'107', session:'第二次', subject:'獸醫普通疾病學' },
  { exam:'vet', file:'questions-vet.json', code:'108100', c:'314', s:'44',   pi:3, year:'108', session:'第二次', subject:'獸醫普通疾病學' },
  { exam:'vet', file:'questions-vet.json', code:'109100', c:'314', s:'44',   pi:3, year:'109', session:'第二次', subject:'獸醫普通疾病學' },
  { exam:'vet', file:'questions-vet.json', code:'110100', c:'314', s:'33',   pi:2, year:'110', session:'第二次', subject:'獸醫實驗診斷學' },
  { exam:'vet', file:'questions-vet.json', code:'110100', c:'314', s:'44',   pi:3, year:'110', session:'第二次', subject:'獸醫普通疾病學' },
  { exam:'vet', file:'questions-vet.json', code:'111100', c:'314', s:'33',   pi:2, year:'111', session:'第二次', subject:'獸醫實驗診斷學' },
  { exam:'vet', file:'questions-vet.json', code:'112100', c:'314', s:'33',   pi:2, year:'112', session:'第二次', subject:'獸醫實驗診斷學' },
  { exam:'vet', file:'questions-vet.json', code:'113090', c:'314', s:'44',   pi:3, year:'113', session:'第二次', subject:'獸醫普通疾病學' },
  // 114: new s codes 1001-1006
  { exam:'vet', file:'questions-vet.json', code:'114090', c:'314', s:'1001', pi:0, year:'114', session:'第二次', subject:'獸醫病理學' },
  { exam:'vet', file:'questions-vet.json', code:'114090', c:'314', s:'1004', pi:3, year:'114', session:'第二次', subject:'獸醫普通疾病學' },
  { exam:'vet', file:'questions-vet.json', code:'114090', c:'314', s:'1005', pi:4, year:'114', session:'第二次', subject:'獸醫傳染病學' },

  // ── NURSING ───────────────────────────────────────────────────────────────
  { exam:'nursing', file:'questions-nursing.json', code:'101030', c:'105', s:'0403', pi:3, year:'101', session:'第一次', subject:'產兒科護理學' },
  { exam:'nursing', file:'questions-nursing.json', code:'104030', c:'109', s:'0504', pi:3, year:'104', session:'第一次', subject:'精神科與社區衛生護理學' },
  { exam:'nursing', file:'questions-nursing.json', code:'105090', c:'106', s:'0505', pi:4, year:'105', session:'第二次', subject:'精神科與社區衛生護理學' },
  { exam:'nursing', file:'questions-nursing.json', code:'106110', c:'101', s:'0101', pi:0, year:'106', session:'第二次', subject:'基礎醫學' },

  // ── TCM1 ──────────────────────────────────────────────────────────────────
  // 100030: c=107, s=0601(基礎一)/0602(基礎二)
  // 100140: c=106, s=0501(基礎一)/0502(基礎二)
  // 101030: c=106, s=0501/0502
  // 102030: c=109, s=0501/0502
  // 103100: c=103, s=0201/0202
  // 102110 (第二次030系): c=103, s=0201/0202
  // 114020: c=317, s=0301/0302
  { exam:'tcm1', file:'questions-tcm1.json', code:'100140', c:'106', s:'0502', pi:1, year:'100', session:'第二次', subject:'中醫基礎醫學(二)' },
  { exam:'tcm1', file:'questions-tcm1.json', code:'102030', c:'109', s:'0501', pi:0, year:'102', session:'第一次', subject:'中醫基礎醫學(一)' },
  { exam:'tcm1', file:'questions-tcm1.json', code:'102030', c:'109', s:'0502', pi:1, year:'102', session:'第一次', subject:'中醫基礎醫學(二)' },
  { exam:'tcm1', file:'questions-tcm1.json', code:'102110', c:'103', s:'0202', pi:1, year:'102', session:'第二次', subject:'中醫基礎醫學(二)' },
  { exam:'tcm1', file:'questions-tcm1.json', code:'103100', c:'103', s:'0201', pi:0, year:'103', session:'第二次', subject:'中醫基礎醫學(一)' },
  { exam:'tcm1', file:'questions-tcm1.json', code:'114020', c:'317', s:'0301', pi:0, year:'114', session:'第一次', subject:'中醫基礎醫學(一)' },

  // ── TCM2 ──────────────────────────────────────────────────────────────────
  // 100030: c=107, s=0605(臨三)/0606(臨四)
  // 100140: c=106, s=0504(臨二)/0505(臨三)/0506(臨四)
  // 105090: c=102, s=0105(臨三)
  { exam:'tcm2', file:'questions-tcm2.json', code:'100030', c:'107', s:'0605', pi:2, year:'100', session:'第一次', subject:'中醫臨床醫學(三)' },
  { exam:'tcm2', file:'questions-tcm2.json', code:'100030', c:'107', s:'0606', pi:3, year:'100', session:'第一次', subject:'中醫臨床醫學(四)' },
  { exam:'tcm2', file:'questions-tcm2.json', code:'100140', c:'106', s:'0504', pi:1, year:'100', session:'第二次', subject:'中醫臨床醫學(二)' },
  { exam:'tcm2', file:'questions-tcm2.json', code:'100140', c:'106', s:'0505', pi:2, year:'100', session:'第二次', subject:'中醫臨床醫學(三)' },
  { exam:'tcm2', file:'questions-tcm2.json', code:'100140', c:'106', s:'0506', pi:3, year:'100', session:'第二次', subject:'中醫臨床醫學(四)' },
  { exam:'tcm2', file:'questions-tcm2.json', code:'105090', c:'102', s:'0105', pi:2, year:'105', session:'第二次', subject:'中醫臨床醫學(三)' },

  // ── PHARMA1 ───────────────────────────────────────────────────────────────
  // s=11: 卷一 pi=0; s=22: 卷二 pi=1; s=33: 卷三 pi=2
  // 100-101: c=103, s=0201(卷一)/0202(卷二)/0204(卷三)
  // 100140: c=103, s=0201/0202/0204
  // 102-104: c=310, s=11/22/44; 104090: c=306, s=11/22/44
  // 105: c=305, s=11/22/33
  // 106+: c=305, s=11/22/33
  { exam:'pharma1', file:'questions-pharma1.json', code:'100030', c:'103', s:'0201', pi:0, year:'100', session:'第一次', subject:'卷一' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'100030', c:'103', s:'0202', pi:1, year:'100', session:'第一次', subject:'卷二' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'100030', c:'103', s:'0204', pi:2, year:'100', session:'第一次', subject:'卷三' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'100140', c:'103', s:'0202', pi:1, year:'100', session:'第二次', subject:'卷二' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'101030', c:'103', s:'0201', pi:0, year:'101', session:'第一次', subject:'卷一' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'101030', c:'103', s:'0202', pi:1, year:'101', session:'第一次', subject:'卷二' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'102020', c:'310', s:'22',   pi:1, year:'102', session:'第一次', subject:'卷二' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'103090', c:'310', s:'44',   pi:2, year:'103', session:'第二次', subject:'卷三' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'104020', c:'310', s:'44',   pi:2, year:'104', session:'第一次', subject:'卷三' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'104090', c:'306', s:'22',   pi:1, year:'104', session:'第二次', subject:'卷二' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'104090', c:'306', s:'44',   pi:2, year:'104', session:'第二次', subject:'卷三' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'105020', c:'305', s:'33',   pi:2, year:'105', session:'第一次', subject:'卷三' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'105100', c:'305', s:'11',   pi:0, year:'105', session:'第二次', subject:'卷一' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'105100', c:'305', s:'22',   pi:1, year:'105', session:'第二次', subject:'卷二' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'105100', c:'305', s:'33',   pi:2, year:'105', session:'第二次', subject:'卷三' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'106020', c:'305', s:'22',   pi:1, year:'106', session:'第一次', subject:'卷二' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'107020', c:'305', s:'11',   pi:0, year:'107', session:'第一次', subject:'卷一' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'107020', c:'305', s:'33',   pi:2, year:'107', session:'第一次', subject:'卷三' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'107100', c:'305', s:'22',   pi:1, year:'107', session:'第二次', subject:'卷二' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'108030', c:'305', s:'11',   pi:0, year:'108', session:'第一次', subject:'卷一' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'108030', c:'305', s:'22',   pi:1, year:'108', session:'第一次', subject:'卷二' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'108030', c:'305', s:'33',   pi:2, year:'108', session:'第一次', subject:'卷三' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'108100', c:'305', s:'22',   pi:1, year:'108', session:'第二次', subject:'卷二' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'109100', c:'305', s:'22',   pi:1, year:'109', session:'第二次', subject:'卷二' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'110020', c:'305', s:'22',   pi:1, year:'110', session:'第一次', subject:'卷二' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'111020', c:'305', s:'11',   pi:0, year:'111', session:'第一次', subject:'卷一' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'113020', c:'305', s:'11',   pi:0, year:'113', session:'第一次', subject:'卷一' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'113020', c:'305', s:'22',   pi:1, year:'113', session:'第一次', subject:'卷二' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'114020', c:'305', s:'22',   pi:1, year:'114', session:'第一次', subject:'卷二' },
  { exam:'pharma1', file:'questions-pharma1.json', code:'115020', c:'305', s:'33',   pi:2, year:'115', session:'第一次', subject:'卷三' },
]

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  // Deduplicate papers (same code+c+s may appear for multiple subjects — not expected
  // but guard against it). We also filter by --exam if given.
  const toProcess = PAPERS.filter(p => !examFilter || p.exam === examFilter)
  console.log(`Processing ${toProcess.length} papers (dryRun=${dryRun})`)

  // Load all JSON files we'll need
  const loaded = {}
  const indexes = {}  // exam → Map<'year|session|subject|number', question>
  for (const p of toProcess) {
    if (!loaded[p.exam]) {
      const fpath = path.join(BACKEND, p.file)
      const raw = JSON.parse(fs.readFileSync(fpath, 'utf8'))
      const arr = Array.isArray(raw) ? raw : raw.questions
      loaded[p.exam] = { raw, arr, fpath }

      // Build index for fast lookup
      const idx = new Map()
      for (const q of arr) {
        if (!q.incomplete || !['missing_image', 'missing_image_dep'].includes(q.gap_reason)) continue
        const k = `${q.roc_year}|${q.session}|${q.subject}|${q.number}`
        idx.set(k, q)
      }
      indexes[p.exam] = idx
    }
  }

  let totalLinked = 0
  let totalImages = 0

  for (const p of toProcess) {
    console.log(`\n--- ${p.exam} ${p.code} c=${p.c} s=${p.s} (${p.year}年${p.session} ${p.subject}) ---`)
    let mapping
    try {
      mapping = await extractPaper({
        exam: p.exam, code: p.code, c: p.c, s: p.s, paperIdx: p.pi, dryRun,
      })
    } catch (e) {
      console.error(`  error: ${e.message}`)
      continue
    }

    const idx = indexes[p.exam]
    // Sort extracted image keys ascending so we can do nearest lookup
    const mappingKeys = Object.keys(mapping).map(Number).sort((a, b) => a - b)
    const MAX_DIST = 15  // max question-number distance for shared-figure association

    let linked = 0
    // Iterate over all missing questions for this paper and find nearest image
    for (const [k, q] of idx) {
      // Only process questions belonging to this paper
      if (q.roc_year !== p.year || q.session !== p.session || q.subject !== p.subject) continue

      const num = q.number
      let urls = mapping[num]  // exact match first

      if (!urls) {
        // Nearest preceding question within MAX_DIST (figure above)
        for (let i = mappingKeys.length - 1; i >= 0; i--) {
          if (mappingKeys[i] < num && num - mappingKeys[i] <= MAX_DIST) { urls = mapping[mappingKeys[i]]; break }
          if (mappingKeys[i] < num) break  // too far back, stop
        }
      }
      if (!urls) {
        // Nearest following question within MAX_DIST (figure below / "see next")
        for (let i = 0; i < mappingKeys.length; i++) {
          if (mappingKeys[i] > num && mappingKeys[i] - num <= MAX_DIST) { urls = mapping[mappingKeys[i]]; break }
          if (mappingKeys[i] > num) break  // too far forward, stop
        }
      }
      if (!urls) continue  // no image found in this paper

      q.image_url = urls[0]
      if (urls.length > 1) q.images = urls
      delete q.incomplete
      delete q.gap_reason
      linked++
      totalImages += urls.length
    }
    console.log(`  linked ${linked} questions (mapping has ${mappingKeys.length} image anchors)`)
    totalLinked += linked
  }

  console.log(`\n=== Total: linked ${totalLinked} questions with ${totalImages} images ===`)

  if (dryRun) { console.log('(dry-run, no write)'); return }
  if (totalLinked === 0) { console.log('Nothing to write.'); return }

  // Write updated JSON files
  const written = new Set()
  for (const p of toProcess) {
    if (written.has(p.exam)) continue
    const { raw, fpath } = loaded[p.exam]
    const tmp = fpath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2))
    fs.renameSync(tmp, fpath)
    console.log(`wrote ${path.basename(fpath)}`)
    written.add(p.exam)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
