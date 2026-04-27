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
      // ── 補：發育構造 ──
      ['體節', 3], ['somite', 3], ['生骨節', 3], ['sclerotome', 3],
      ['皮節', 3], ['dermatome', 3], ['肌節', 3], ['myotome', 3],
      ['神經嵴', 3], ['neural crest', 3], ['neural plate', 3],
      ['鰓弓', 3], ['鰓裂', 3], ['branchial arch', 3], ['pharyngeal arch', 3], ['pharyngeal pouch', 3],
      // ── 心血管胚胎 ──
      ['動脈導管', 3], ['ductus arteriosus', 3], ['卵圓孔', 3], ['foramen ovale', 3],
      ['臍動脈', 3], ['臍靜脈', 3], ['umbilical', 2],
      // ── 泌尿生殖胚胎 ──
      ['Wolffian', 3], ['Müllerian', 3], ['泌尿生殖嵴', 3],
      ['前腎', 2], ['中腎', 2], ['後腎', 2],
      // ── 消化胚胎 ──
      ['前腸', 2], ['中腸', 2], ['後腸', 2], ['foregut', 2], ['midgut', 2], ['hindgut', 2],
      // ── 缺陷 ──
      ['脊柱裂', 3], ['spina bifida', 3], ['無腦症', 3], ['anencephaly', 3],
      ['唇顎裂', 3], ['cleft', 2],
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
      // ── 補：心臟血管生理 ──
      ['心房', 2], ['心室', 2], ['atria', 2], ['ventricle', 2],
      ['主動脈瓣', 3], ['二尖瓣', 3], ['三尖瓣', 3], ['肺動脈瓣', 3],
      ['aortic valve', 3], ['mitral valve', 3], ['tricuspid', 2],
      ['等容收縮', 3], ['isovolumic', 3], ['cardiac cycle', 3],
      ['動脈壓', 2], ['平均動脈壓', 3], ['mean arterial pressure', 3],
      ['感壓接受器', 3], ['baroreceptor', 3], ['化學接受器', 2], ['chemoreceptor', 2],
      ['心電圖', 2], ['ECG', 2], ['EKG', 2],
      // ── 神經/感覺生理 ──
      ['肌梭', 3], ['muscle spindle', 3], ['反射弧', 3], ['reflex arc', 3],
      ['脊髓反射', 3], ['stretch reflex', 3], ['膝反射', 3],
      ['交感神經', 2], ['副交感神經', 2], ['sympathetic', 2], ['parasympathetic', 2],
      ['自主神經', 2], ['autonomic', 2],
      ['視網膜', 2], ['retina', 2], ['視桿', 2], ['視錐', 2], ['rod', 2], ['cone', 2],
      ['耳蝸', 2], ['cochlea', 2], ['前庭', 2], ['vestibular', 2],
      // ── 呼吸/腎臟/消化 ──
      ['肺通氣', 2], ['ventilation', 2], ['呼氣', 1], ['吸氣', 1],
      ['潮氣量', 3], ['tidal volume', 3], ['肺活量', 3], ['vital capacity', 3],
      ['gas exchange', 2], ['氣體交換', 2],
      ['腎絲球過濾率', 3], ['GFR', 2], ['再吸收', 2], ['reabsorption', 2],
      ['尿液', 1], ['抗利尿', 2], ['ADH', 2], ['vasopressin', 2], ['aldosterone', 2],
      ['胃酸', 2], ['壁細胞', 3], ['parietal cell', 3], ['主細胞', 3], ['chief cell', 3],
      // ── 內分泌生理 ──
      ['胰島素', 2], ['insulin', 2], ['升糖素', 2], ['glucagon', 2],
      ['甲狀腺素', 2], ['thyroxine', 2], ['T3', 2], ['T4', 2], ['TSH', 2],
      ['類固醇', 1], ['cortisol', 2], ['腎上腺素', 2], ['adrenaline', 2],
      ['黃體素', 2], ['動情素', 2], ['estrogen', 2], ['progesterone', 2], ['testosterone', 2],
      // ── 體液/電解質 ──
      ['鈉離子', 2], ['鉀離子', 2], ['鈣離子', 2],
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
      // ── 補：脂質/醣類代謝 ──
      ['酮體', 3], ['ketone body', 3], ['ketone bodies', 3],
      ['脂肪酸', 2], ['fatty acid', 2], ['β-氧化', 3], ['beta-oxidation', 3],
      ['膽固醇', 2], ['cholesterol', 2], ['lipoprotein', 2], ['HDL', 2], ['LDL', 2],
      ['三酸甘油酯', 3], ['triglyceride', 3],
      ['醣類', 1], ['glucose', 1], ['lactate', 2], ['pyruvate', 2],
      ['glycogen', 2], ['肝醣', 2],
      // ── 維生素/輔因子 ──
      ['維生素', 1], ['vitamin', 1], ['cofactor', 2], ['coenzyme', 2],
      // ── 氨基酸代謝 ──
      ['尿素循環', 3], ['urea cycle', 3], ['ammonia', 2], ['glutamine', 2],
      // ── 核酸/分子生物 ──
      ['mRNA', 2], ['tRNA', 2], ['rRNA', 2], ['ribosome', 2], ['核糖體', 2],
      ['DNA polymerase', 3], ['RNA polymerase', 3], ['核苷酸', 2], ['nucleotide', 2],
      ['基因突變', 2], ['mutation', 1], ['遺傳密碼', 3], ['codon', 2], ['anticodon', 3],
      // ── 蛋白質結構 ──
      ['α螺旋', 3], ['β摺疊', 3], ['alpha helix', 3], ['beta sheet', 3],
      ['二級結構', 2], ['三級結構', 2], ['四級結構', 2],
      // ── 訊息傳遞 ──
      ['訊息傳遞', 2], ['signaling', 2], ['cAMP', 2], ['cGMP', 2], ['kinase', 2],
      ['phosphorylation', 2], ['磷酸化', 2],
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

// Match an English/abbrev term using word boundaries to avoid substring false positives.
//   'IQ' should not match 'obliquus', 'CI' should not match 'incidence', 'OR' should not match 'work'
// Heuristic: if term is pure ASCII letters/digits (no spaces or hyphens) and ≤ 4 chars, use word boundary.
//   Longer/multi-word English terms (e.g. 'odds ratio', 'cohort study') and Chinese terms keep substring match.
const SHORT_ENG_RE = /^[a-z0-9]{1,4}$/i
function termMatches(text, lowerText, term) {
  if (SHORT_ENG_RE.test(term)) {
    // word boundary: term is preceded/followed by non-word char or string edge
    const re = new RegExp('(?:^|[^a-z0-9])' + term.toLowerCase() + '(?:$|[^a-z0-9])', 'i')
    return re.test(text)
  }
  return lowerText.includes(term.toLowerCase())
}

function scoreQuestion(text) {
  const lower = text.toLowerCase()
  const scores = {}
  for (const [tag, cfg] of Object.entries(KW)) {
    let s = 0
    for (const [term, w] of cfg.terms) {
      if (termMatches(text, lower, term)) s += w
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
      // No keyword match — 保留現有 tag（如果合法），否則才用 paper default
      // 避免：把已經 smoothed 過的正確 tag reset 掉
      if (q.subject_tag && TAG_META[q.subject_tag]) {
        chosen = q.subject_tag
      } else {
        chosen = PAPER_DEFAULTS[q.subject]
      }
      fallback++
    } else {
      entries.sort((a, b) => b[1] - a[1])
      const top = entries[0]
      const second = entries[1]
      // Confidence: 最高分需要明顯領先（避免 1 分微弱命中蓋過 smoothed 結果）
      // 如果現有 tag 也有分但不是最高，且差距 < 2，保留現有 tag
      const currentScore = scores[q.subject_tag] || 0
      if (currentScore > 0 && top[1] - currentScore < 2 && top[0] !== q.subject_tag) {
        chosen = q.subject_tag
      } else {
        chosen = top[0]
      }
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
