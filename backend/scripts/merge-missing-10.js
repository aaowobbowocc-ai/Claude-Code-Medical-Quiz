#!/usr/bin/env node
// Insert 10 hand-transcribed missing nursing questions into questions-nursing.json.
const fs = require('fs')
const path = require('path')

const FILE = path.join(__dirname, '..', 'questions-nursing.json')
const db = JSON.parse(fs.readFileSync(FILE, 'utf8'))

const NEW = [
  {
    id: '110030_0301_65', roc_year: '110', session: '第一次', exam_code: '110030',
    subject: '基礎醫學', subject_tag: 'basic_medicine', subject_name: '基礎醫學',
    stage_id: 0, number: 65,
    question: '下列何者存在於動物細胞，而不存在於細菌？',
    options: {
      A: '核糖體（ribosome）',
      B: '細胞壁（cell wall）',
      C: '質體（plasmid）',
      D: '溶酶體（lysosome）',
    },
    answer: 'D', explanation: '',
  },
  {
    id: '110110_0302_22', roc_year: '110', session: '第二次', exam_code: '110110',
    subject: '基本護理學與護理行政', subject_tag: 'basic_nursing', subject_name: '基本護理學與護理行政',
    stage_id: 0, number: 22,
    question: '醫囑Coumadin 1# p.o. stat & q.d.×3 days then 0.5# p.o. q.d.，請問第 5 天時Coumadin 應給予幾顆？',
    options: { A: '0.5#', B: '1#', C: '1.5#', D: '2#' },
    answer: 'A', explanation: '',
  },
  {
    id: '110110_0303_51', roc_year: '110', session: '第二次', exam_code: '110110',
    subject: '內外科護理學', subject_tag: 'med_surg', subject_name: '內外科護理學',
    stage_id: 0, number: 51,
    question: '下列何者不屬於第 Ⅰ 型過敏反應？',
    options: {
      A: '接觸性皮膚炎',
      B: '氣喘',
      C: '枯草熱',
      D: '異位性皮膚炎',
    },
    answer: 'A', explanation: '',
  },
  {
    id: '110110_0305_34', roc_year: '110', session: '第二次', exam_code: '110110',
    subject: '精神科與社區衛生護理學', subject_tag: 'psych_community', subject_name: '精神科與社區衛生護理學',
    stage_id: 0, number: 34,
    question: '有關罹患注意力缺陷過動症（ADHD）學齡期兒童的治療計畫，下列敘述何者錯誤？',
    options: {
      A: '可使用中樞神經興奮劑 Ritalin®，來改善其衝動及活動量過高之行為',
      B: '為避免病情復發，中樞神經興奮劑宜長期服用，絕對不可停藥',
      C: '可合併使用藥物治療及感覺統合治療，以增加治療效益',
      D: '急性住院期間宜安排不具攻擊性的活動',
    },
    answer: 'B', explanation: '',
  },
  {
    id: '112110_0201_25', roc_year: '112', session: '第二次', exam_code: '112110',
    subject: '基礎醫學', subject_tag: 'basic_medicine', subject_name: '基礎醫學',
    stage_id: 0, number: 25,
    question: '由於發炎導致組織表面壞死，稱為：',
    options: {
      A: '膿瘍（abscess）',
      B: '潰瘍（ulcer）',
      C: '肉芽腫（granuloma）',
      D: '蟹足腫（keloid）',
    },
    answer: 'B', explanation: '',
  },
  {
    id: '114100_0201_8', roc_year: '114', session: '第二次', exam_code: '114100',
    subject: '基礎醫學', subject_tag: 'basic_medicine', subject_name: '基礎醫學',
    stage_id: 0, number: 8,
    question: '下列何者是牙齒的主體結構？',
    options: {
      A: '琺瑯質（enamel）',
      B: '牙質（dentin）',
      C: '白堊質（cementum）',
      D: '齒髓（tooth pulp）',
    },
    answer: 'B', explanation: '',
  },
  {
    id: '114100_0202_3', roc_year: '114', session: '第二次', exam_code: '114100',
    subject: '基本護理學與護理行政', subject_tag: 'basic_nursing', subject_name: '基本護理學與護理行政',
    stage_id: 0, number: 3,
    question: '有關南丁格爾對護理角色所下的定義，下列敘述何者正確？',
    options: {
      A: '以自然法則，提供個體合宜的環境以恢復健康',
      B: '協助個體運用資源，提升自身與環境互動的能量',
      C: '促進個體內、外在系統功能的調和與平衡',
      D: '協助個體在身、心各功能的適應與平衡',
    },
    answer: 'A', explanation: '',
  },
  {
    id: '114100_0203_40', roc_year: '114', session: '第二次', exam_code: '114100',
    subject: '內外科護理學', subject_tag: 'med_surg', subject_name: '內外科護理學',
    stage_id: 0, number: 40,
    question: '有關泌尿道感染及衛教之敘述，下列何者最適當？',
    options: {
      A: '建議食用鹼化尿液的食物如柑橘及奶製品',
      B: '女性病人最常見的感染源為陰道滴蟲感染',
      C: '泌尿道感染病人的典型症狀為無痛性血尿',
      D: '院內泌尿道感染常見於泌尿道侵入性檢查後',
    },
    answer: 'D', explanation: '',
  },
  {
    id: '114100_0204_43', roc_year: '114', session: '第二次', exam_code: '114100',
    subject: '產兒科護理學', subject_tag: 'obs_ped', subject_name: '產兒科護理學',
    stage_id: 0, number: 43,
    question: '潘小弟，3 歲，因為身體不適至醫院求治，經醫師診斷後確診為血友病，有關臨床表徵的敘述，下列何者正確？',
    options: {
      A: '皮膚出現瘀血，刷牙時牙齦出血',
      B: '臉色蒼白，呼吸快速或突然昏倒',
      C: '易疲倦、食慾不振，身體易感染',
      D: '皮膚出現黃疸現象，肝、脾腫大',
    },
    answer: 'A', explanation: '',
  },
  {
    id: '114100_0205_19', roc_year: '114', session: '第二次', exam_code: '114100',
    subject: '精神科與社區衛生護理學', subject_tag: 'psych_community', subject_name: '精神科與社區衛生護理學',
    stage_id: 0, number: 19,
    question: '有關老年憂鬱症的敘述，下列何者錯誤？',
    options: {
      A: '老年憂鬱症通常會有明顯的憂鬱情緒表現',
      B: '女性老年人較男性老年人發生憂鬱症的比例高',
      C: '城市老年人較鄉村老年人發生憂鬱症的比例高',
      D: '慢性病老年人較一般老年人發生憂鬱症比例高',
    },
    answer: 'A', explanation: '',
  },
]

// Guard: make sure none of the IDs already exist
const existing = new Set(db.questions.map(q => q.id))
const dupes = NEW.filter(q => existing.has(q.id))
if (dupes.length) {
  console.error('DUPLICATE IDs:', dupes.map(q => q.id))
  process.exit(1)
}

// Insert each new question after the previous number in the same (code, subject) group
// so the natural order is preserved (matters for exam-years paper grouping).
for (const nq of NEW) {
  // Find the index of the question at (code, subject, number-1), or the last one
  // in that group with number < nq.number
  let insertAt = -1
  for (let i = 0; i < db.questions.length; i++) {
    const q = db.questions[i]
    if (q.exam_code === nq.exam_code && q.subject === nq.subject && q.number < nq.number) {
      insertAt = i + 1
    }
  }
  if (insertAt < 0) {
    // Fallback: push at end of the first occurrence of same exam_code+subject
    for (let i = 0; i < db.questions.length; i++) {
      const q = db.questions[i]
      if (q.exam_code === nq.exam_code && q.subject === nq.subject) insertAt = i + 1
    }
  }
  if (insertAt < 0) insertAt = db.questions.length
  db.questions.splice(insertAt, 0, nq)
}

db.total = db.questions.length
if (db.metadata) {
  db.metadata.total = db.questions.length
  db.metadata.last_updated = new Date().toISOString()
}

fs.writeFileSync(FILE, JSON.stringify(db, null, 2))
console.log(`Inserted ${NEW.length} questions. New total: ${db.total}`)
