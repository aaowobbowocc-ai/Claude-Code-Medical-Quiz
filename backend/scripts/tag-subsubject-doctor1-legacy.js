#!/usr/bin/env node
// 為 doctor1 100-112 年（舊制混排）題目用關鍵字分類器補子科目 tag。
//
// 背景：113 年起 doctor1 才有固定分卷（醫學(一) 31/5/10/27/27、醫學(二) 28/7/15/25/25），
// 100-112 年舊制每卷 100 題但各科目混排，無法用題號區間。
//
// 策略：
//   - 只處理 roc_year ≤ 112 的醫學(一)/(二) 題目
//   - 計算每題對 10 個子科目的關鍵字命中分數
//   - 選分數最高者為 subject_tag；若完全沒命中，用 paper 預設（醫學一→anatomy, 醫學二→pathology）
//   - 113+ 題目已有正確分類，略過
//
// ⚠️ 不要在已 smoothed 的資料上重跑此腳本！
//   smooth-subject-tags.js 會根據鄰居把單一錯誤分類修正成多數決。
//   若已 smoothed 後重跑此 classifier，無 keyword 命中的題目會被 reset 回 paper default，
//   抹掉 smoothing 修正過的好分類（2026-04-27 實測：淨損失 ~200 題公衛分類）。
//
//   只在以下情境執行：
//     1. 新爬蟲剛抓完，題目沒有 subject_tag
//     2. 想完全 re-classify（接受會抹掉 smoothing 結果，需後續重跑 smooth-subject-tags.js）

const fs = require('fs')
const path = require('path')
const QFILE = path.join(__dirname, '..', 'questions.json')

// 子科目 × 關鍵字字典（中文 + 英文，weight 隱含為 1；高辨識性詞 weight=3）
const KW = {
  anatomy: {
    weight: 1,
    terms: [
      ['解剖', 3], ['骨', 1], ['韌帶', 2], ['關節', 1], ['肌肉', 1], ['神經分布', 2],
      ['顱骨', 3], ['血管供應', 2], ['動脈', 1], ['靜脈', 1], ['淋巴', 1],
      ['頭顱', 2], ['脊椎', 1], ['脊髓', 1], ['四肢', 1], ['顏面', 2],
      ['artery', 1], ['vein', 1], ['nerve innervation', 3], ['ligament', 1],
      ['tendon', 1], ['joint', 1], ['cranium', 2], ['vertebra', 1],
    ]
  },
  embryology: {
    weight: 1,
    terms: [
      ['胚胎', 3], ['胚', 1], ['發育', 1], ['衍生自', 3], ['胎兒', 2], ['胚芽', 3],
      ['胚層', 3], ['神經孔', 3], ['絨毛膜', 2], ['羊膜', 2], ['妊娠', 1],
      ['ectoderm', 3], ['mesoderm', 3], ['endoderm', 3], ['fetal', 2], ['embryo', 3],
      ['placenta', 2], ['neural tube', 3], ['chorion', 2], ['gestation', 1],
      ['derive', 1], ['derives from', 3], ['derived from', 3],
    ]
  },
  histology: {
    weight: 1,
    terms: [
      ['組織學', 3], ['上皮', 3], ['結締組織', 3], ['肌纖維', 1], ['細胞骨架', 2],
      ['偽複層', 3], ['柱狀上皮', 3], ['鱗狀上皮', 3], ['腺體', 1],
      ['epithelium', 3], ['connective tissue', 3], ['columnar', 2], ['squamous', 2],
      ['stratified', 2], ['pseudostratified', 3], ['basement membrane', 2],
      ['gland', 1], ['histology', 3],
    ]
  },
  physiology: {
    weight: 1,
    terms: [
      ['生理', 2], ['分泌', 1], ['吸收', 1], ['傳導', 1], ['收縮', 1], ['運輸', 1],
      ['平衡', 1], ['離子', 2], ['動作電位', 3], ['膜電位', 3], ['滲透壓', 2],
      ['內分泌', 2], ['激素', 1], ['內在因子', 2], ['血壓', 2], ['心輸出', 2],
      ['肺泡', 2], ['腎小球', 2], ['神經傳遞', 2], ['神經傳導物質', 3],
      ['action potential', 3], ['membrane potential', 3], ['osmolarity', 2],
      ['secretion', 1], ['absorption', 1], ['hormone', 1], ['synapse', 2],
      ['cardiac output', 2], ['glomerular', 2], ['excretion', 1],
    ]
  },
  biochemistry: {
    weight: 1,
    terms: [
      ['生化', 2], ['生物化學', 3], ['胺基酸', 3], ['蛋白質', 1], ['酵素', 2], ['催化', 2],
      ['輔酶', 3], ['代謝', 1], ['糖解', 3], ['糖質新生', 3], ['三羧酸', 3], ['檸檬酸循環', 3],
      ['氧化磷酸化', 3], ['電子傳遞', 2], ['DNA', 2], ['RNA', 2], ['基因表現', 2],
      ['轉錄', 2], ['轉譯', 2], ['複製', 1], ['基因工程', 2], ['糖皮質', 1],
      ['amino acid', 3], ['enzyme', 2], ['protein', 1], ['metabolism', 1],
      ['glycolysis', 3], ['gluconeogenesis', 3], ['TCA', 3], ['oxidative phosphorylation', 3],
      ['transcription', 2], ['translation', 2], ['replication', 1], ['biochemistry', 3],
      ['Michaelis', 3], ['Km', 2], ['Vmax', 2],
    ]
  },
  microbiology: {
    weight: 1,
    terms: [
      ['微生物', 3], ['細菌', 2], ['病毒', 2], ['黴菌', 2], ['真菌', 2], ['免疫', 2],
      ['抗體', 1], ['抗原', 1], ['補體', 2], ['T細胞', 2], ['B細胞', 2], ['疫苗', 1],
      ['革蘭氏', 3], ['球菌', 2], ['桿菌', 2], ['內毒素', 3], ['外毒素', 3],
      ['bacterium', 2], ['virus', 2], ['bacterial', 2], ['viral', 2],
      ['gram-positive', 3], ['gram-negative', 3], ['immunoglobulin', 2], ['antibody', 1],
      ['antigen', 1], ['complement', 2], ['vaccine', 1], ['pathogen', 2],
      ['endotoxin', 3], ['exotoxin', 3], ['HIV', 2], ['hepatitis', 2],
    ]
  },
  parasitology: {
    weight: 1,
    terms: [
      ['寄生蟲', 3], ['線蟲', 3], ['絛蟲', 3], ['吸蟲', 3], ['原蟲', 3],
      ['蠕蟲', 3], ['瘧原蟲', 3], ['阿米巴', 3], ['蛔蟲', 3], ['鉤蟲', 3],
      ['血吸蟲', 3], ['囊蟲', 3], ['幼蟲', 2], ['蟲卵', 2], ['中間宿主', 2],
      ['parasite', 3], ['nematode', 3], ['cestode', 3], ['trematode', 3],
      ['protozoa', 3], ['Plasmodium', 3], ['Entamoeba', 3], ['Ascaris', 3],
      ['Schistosoma', 3], ['hookworm', 3], ['tapeworm', 3],
      ['棘頜口', 3], ['絲蟲', 3], ['海獸胃線蟲', 3], ['蠅蛆', 3], ['Anisakis', 3],
    ]
  },
  pharmacology: {
    weight: 1,
    terms: [
      ['藥物', 2], ['藥理', 3], ['副作用', 2], ['劑量', 1], ['半衰期', 2], ['毒性', 1],
      ['致效劑', 3], ['拮抗劑', 3], ['受體', 1], ['用藥', 1], ['抗生素', 2], ['化療', 1],
      ['agonist', 3], ['antagonist', 3], ['receptor', 1], ['dose', 1], ['toxicity', 1],
      ['antibiotic', 2], ['drug', 1], ['pharmacokinetic', 3], ['pharmacodynamic', 3],
      ['metronidazole', 2], ['penicillin', 2], ['cyclosporine', 2], ['NSAID', 2],
      ['cephalosporin', 2], ['aminoglycoside', 2],
    ]
  },
  pathology: {
    weight: 1,
    terms: [
      ['病理', 3], ['病變', 2], ['腫瘤', 2], ['癌', 1], ['發炎', 1], ['壞死', 2],
      ['增生', 2], ['肉芽腫', 3], ['硬化', 1], ['梗塞', 2], ['凋亡', 2], ['纖維化', 2],
      ['惡性', 1], ['良性', 1], ['轉移', 1], ['Alzheimer', 2], ['蛋白堆積', 2],
      ['inflammation', 1], ['necrosis', 2], ['neoplasm', 3], ['tumor', 2], ['carcinoma', 3],
      ['granuloma', 3], ['fibrosis', 2], ['apoptosis', 2], ['metastasis', 2],
      ['hyperplasia', 2], ['dysplasia', 2], ['infarction', 2], ['Babinski', 2],
      ['keloid', 2], ['sarcoma', 3],
    ]
  },
  public_health: {
    weight: 1,
    terms: [
      ['公共衛生', 3], ['公衛', 2], ['流行病學', 3], ['發生率', 3], ['盛行率', 3],
      ['健保', 2], ['醫療政策', 2], ['健康服務', 2], ['預防醫學', 2], ['疾病管制', 2],
      ['統計', 1], ['問卷', 1], ['樣本', 1], ['相對危險', 3], ['絕對危險', 3],
      ['平衡計分卡', 3], ['測量尺度', 3], ['管理方法', 1], ['盲性', 2], ['單盲', 2], ['雙盲', 2],
      ['epidemiology', 3], ['incidence', 3], ['prevalence', 3], ['relative risk', 3],
      ['cohort', 3], ['case-control', 3], ['RCT', 2], ['randomized', 2], ['blinded', 2],
      ['public health', 3], ['health service', 2], ['health policy', 2],
      ['biostatistics', 3],
      ['IQ', 1], ['智力測驗', 2], ['多氯', 2],
      // ── 補：明確流行病學/統計術語（避免加 mortality/sensitivity 等臨床常見詞）──
      ['SMR', 3], ['標準化死亡比', 3], ['standardized mortality', 3],
      ['odds ratio', 3], ['勝算比', 3],
      ['hazard ratio', 3], ['危險比', 3],
      ['attributable risk', 3], ['歸因危險', 3],
      ['信賴區間', 3], ['confidence interval', 3],
      // 研究設計
      ['世代研究', 3], ['個案對照', 3], ['案例對照', 3], ['橫斷研究', 3], ['橫斷面研究', 3],
      ['生態學研究', 3], ['cross-sectional', 3],
      ['confounding', 3], ['confounder', 3], ['干擾因子', 3],
      ['霍桑效應', 3], ['hawthorne', 3], ['lead-time bias', 3], ['length bias', 3],
      ['selection bias', 3], ['recall bias', 3],
      // 篩檢
      ['陽性預測值', 3], ['陰性預測值', 3], ['positive predictive value', 3], ['negative predictive value', 3],
      ['screening test', 3], ['預防接種', 2],
      // 環境/職業（特異性詞彙）
      ['環境暴露', 3], ['職業病', 3], ['職業暴露', 3], ['空氣污染', 3],
      ['砷暴露', 3], ['鉛中毒', 3], ['戴奧辛', 3], ['二手菸', 3],
      // 衛生政策（特異性詞彙）
      ['全民健保', 3], ['疾管署', 3], ['世界衛生組織', 3],
      ['長期照護', 3], ['health promotion', 3],
      // 統計方法（特異性）
      ['logistic regression', 3], ['卡方檢定', 3], ['chi-square', 3], ['變異數分析', 3], ['ANOVA', 3],
    ]
  },
}

function scoreQuestion(text) {
  const scores = {}
  for (const [tag, cfg] of Object.entries(KW)) {
    let s = 0
    for (const [term, w] of cfg.terms) {
      // Case-insensitive substring match. For Chinese simple includes works; for English also.
      const lower = text.toLowerCase()
      const t = term.toLowerCase()
      if (lower.includes(t)) s += w
    }
    scores[tag] = s
  }
  return scores
}

const TAG_META = {
  anatomy:      { name: '解剖學',       stage_id: 1 },
  physiology:   { name: '生理學',       stage_id: 2 },
  biochemistry: { name: '生物化學',     stage_id: 3 },
  histology:    { name: '組織學',       stage_id: 4 },
  embryology:   { name: '胚胎學',       stage_id: 10 },
  microbiology: { name: '微生物與免疫', stage_id: 5 },
  parasitology: { name: '寄生蟲學',     stage_id: 6 },
  pharmacology: { name: '藥理學',       stage_id: 7 },
  pathology:    { name: '病理學',       stage_id: 8 },
  public_health:{ name: '公共衛生',     stage_id: 9 },
}

const PAPER_DEFAULTS = {
  '醫學(一)': 'anatomy',   // fallback when no keyword hits
  '醫學(二)': 'pathology',
}

function isLegacyYear(year) {
  const n = parseInt(year, 10)
  return n >= 100 && n <= 112
}

function main() {
  const data = JSON.parse(fs.readFileSync(QFILE, 'utf8'))
  const arr = Array.isArray(data) ? data : data.questions
  let touched = 0, fallback = 0, skipped = 0
  const stats = {}
  for (const q of arr) {
    if (!isLegacyYear(q.roc_year)) { skipped++; continue }
    if (!['醫學(一)', '醫學(二)'].includes(q.subject)) { skipped++; continue }

    const body = [
      q.question || '',
      (q.options && q.options.A) || '',
      (q.options && q.options.B) || '',
      (q.options && q.options.C) || '',
      (q.options && q.options.D) || '',
    ].join(' ')

    const scores = scoreQuestion(body)
    const entries = Object.entries(scores).filter(([,s]) => s > 0)
    let chosen
    if (entries.length === 0) {
      chosen = PAPER_DEFAULTS[q.subject]
      fallback++
    } else {
      entries.sort((a, b) => b[1] - a[1])
      chosen = entries[0][0]
    }
    const meta = TAG_META[chosen]
    q.subject_tag = chosen
    q.subject_name = meta.name
    q.stage_id = meta.stage_id
    stats[chosen] = (stats[chosen] || 0) + 1
    touched++
  }
  console.log('doctor1 legacy (100-112) re-tag:')
  console.log('  touched:', touched, '| fallback (no kw hit):', fallback, '| skipped (113+ or other):', skipped)
  console.log('\ndistribution:')
  for (const [t, c] of Object.entries(stats).sort((a,b)=>b[1]-a[1])) console.log('  ', t.padEnd(18), c)

  if (process.argv.includes('--dry-run')) { console.log('\n(dry-run, no write)'); return }
  const tmp = QFILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, QFILE)
  console.log('\nwrote', QFILE)
}

main()
