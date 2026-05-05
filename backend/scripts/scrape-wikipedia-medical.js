#!/usr/bin/env node
/**
 * Scrape Chinese Wikipedia medical articles into the RAG knowledge base.
 *
 * Wikipedia content is CC BY-SA 3.0 / 4.0 — commercial use OK with attribution
 * (we keep `metadata.attribution` on each chunk).
 *
 * Two modes:
 *   --seeds   ingest the curated TAIWAN_EXAM_SEEDS list (~150 high-yield topics)
 *   --category=NAME  recursively crawl a Wikipedia category (e.g. "藥物")
 */

require('dotenv/config')
const rag = require('../rag')

const WIKI_API = 'https://zh.wikipedia.org/w/api.php'

// Curated list of Taiwan-medical-exam-relevant topics. Tier 1 = original ~130
// (kept for backwards compatibility / rerun idempotency). Tier 2-5 = expansion.
const TAIWAN_EXAM_SEEDS = [
  // ── Tier 1: original seeds ───────────────────────────────────────────────
  '高血壓', '心肌梗塞', '心臟衰竭', '心房顫動', '心律不整', '主動脈剝離', '心包填塞',
  '深部靜脈血栓', '肺栓塞',
  '糖尿病', '甲狀腺功能亢進症', '甲狀腺功能低下症', '庫欣氏症候群', '艾迪生氏病',
  '慢性腎臟病', '急性腎損傷', '腎絲球腎炎', '腎病症候群', '尿路結石',
  '肝硬化', 'B型肝炎', 'C型肝炎', '消化性潰瘍', '克隆氏症', '潰瘍性結腸炎', '大腸直腸癌',
  '胰臟炎', '膽結石',
  '肺炎', '結核病', '氣喘', '慢性阻塞性肺病', '肺癌', '肺纖維化',
  '中風', '腦中風', '帕金森氏症', '阿茲海默症', '癲癇', '多發性硬化症', '重症肌無力',
  '蜘蛛網膜下腔出血',
  '敗血症', '心內膜炎', '尿路感染', '腦膜炎', 'HIV', '愛滋病', '梅毒', '淋病',
  '貧血', '缺鐵性貧血', '白血病', '淋巴瘤', '多發性骨髓瘤', '彌散性血管內凝血',
  '紅斑性狼瘡', '類風濕性關節炎', '僵直性脊椎炎', '痛風',
  '子宮頸癌', '乳癌', '子宮內膜癌', '卵巢癌', '子癇前症',
  '川崎氏病', '腸病毒', '麻疹', '德國麻疹', '水痘', '腮腺炎',
  '憂鬱症', '思覺失調症', '雙相情緒障礙症', '焦慮症',
  '心電圖', '電腦斷層掃描', '磁振造影',
  'ACE抑制劑', '鈣離子通道阻斷劑', '乙型阻斷劑', '利尿劑', '抗凝血劑', '抗生素',
  '非類固醇消炎藥', '皮質類固醇', '降血糖藥', '胰島素', 'Statin', 'Aspirin',
  '心臟', '肺臟', '肝臟', '腎臟', '腦', '神經系統', '消化系統', '免疫系統',
  '金黃色葡萄球菌', '大腸桿菌', '肺炎鏈球菌', '結核桿菌', '人類免疫缺陷病毒', '流感病毒',
  '糖解作用', '檸檬酸循環', 'DNA複製', '蛋白質合成',
  '發炎反應', '凋亡', '腫瘤',

  // ── Tier 2: cardiovascular detail ────────────────────────────────────────
  '主動脈瓣狹窄', '二尖瓣狹窄', '二尖瓣脫垂', '主動脈瓣閉鎖不全', '法洛氏四重症',
  '心房中隔缺損', '心室中隔缺損', '開放性動脈導管', '心肌病', '擴張性心肌病',
  '肥厚性心肌病', '限制性心肌病', '心肌炎', '風濕熱', '心因性休克',
  '陣發性上心室心搏過速', '心室頻脈', '心室顫動', '緩脈症候群', '右束支傳導阻滯',
  '高血脂', '動脈粥樣硬化', '末梢動脈疾病', '雷諾氏現象', '休克',

  // ── Tier 3: pulmonary & critical care ────────────────────────────────────
  '氣胸', '張力性氣胸', '肋膜積液', '肺水腫', '急性呼吸窘迫症候群', '間質性肺病',
  '阻塞性睡眠呼吸中止症', '肺塵症', '塵肺症', '支氣管擴張症', '矽肺症',
  '肺動脈高壓', '肺炎黴漿菌', '退伍軍人病', '吸入性肺炎',

  // ── Tier 4: GI & hepatobiliary ───────────────────────────────────────────
  '胃食道逆流', '幽門桿菌', '食道癌', '胃癌', '肝細胞癌', '膽管癌',
  '膽囊炎', '膽管炎', '腹膜炎', '急性闌尾炎', '憩室炎', '腸阻塞', '腸套疊',
  '腸缺血', '痔瘡', '肛裂', '肛門廔管', '食道靜脈曲張', '腸躁症', '吸收不良症候群',
  '乳糜瀉', '原發性膽汁性膽管炎', 'Wilson氏病', '血色素沉積症',

  // ── Tier 5: renal/urology ────────────────────────────────────────────────
  '多囊腎', 'IgA腎病', '微小變化型腎病變', '局部節段性腎絲球硬化症',
  '膜性腎絲球腎炎', '糖尿病腎病變', '高血壓腎硬化', '腎細胞癌', '膀胱癌',
  '前列腺癌', '前列腺增生', '膀胱炎', '腎盂腎炎', '尿失禁',

  // ── Tier 6: endocrine ────────────────────────────────────────────────────
  '糖尿病酮酸中毒', '高滲透壓高血糖', '低血糖症', '高血鈣', '低血鈣', '高血鉀',
  '低血鉀', '副甲狀腺功能亢進症', '副甲狀腺功能低下症', '嗜鉻細胞瘤', '原發性醛固酮增多症',
  '腦下垂體腫瘤', '肢端肥大症', '尿崩症', '抗利尿激素分泌失調症候群',
  '多囊性卵巢症候群', '高泌乳素血症',

  // ── Tier 7: neurology ────────────────────────────────────────────────────
  '腦瘤', '腦膿瘍', '硬膜下血腫', '硬膜外血腫', '顱內高壓', '腦水腫', '腦疝脫',
  '偏頭痛', '叢發性頭痛', '緊張型頭痛', '顳動脈炎', '巴瑞氏症候群', '吉巴氏症候群',
  '周邊神經病變', '腕隧道症候群', '坐骨神經痛', '失智症', '路易氏體失智症',
  '亨丁頓舞蹈症', '肌萎縮性脊髓側索硬化症', '小腦萎縮症', '腦性麻痺', '神經膠質瘤',

  // ── Tier 8: hematology / oncology ────────────────────────────────────────
  '再生不良性貧血', '溶血性貧血', '地中海貧血', '鐮刀型紅血球疾病', 'G6PD缺乏症',
  '惡性貧血', '巨幼細胞性貧血', '血友病', '血小板減少性紫斑症', 'von Willebrand病',
  '骨髓化生不良症候群', '真性紅血球增多症', '原發性血小板增多症',
  '急性骨髓性白血病', '急性淋巴性白血病', '慢性骨髓性白血病', '慢性淋巴性白血病',
  '何杰金氏淋巴瘤', '非何杰金氏淋巴瘤', '黑色素瘤', '基底細胞癌', '鱗狀細胞癌',
  '惡性間皮瘤', '腎上腺癌', '甲狀腺癌', '神經母細胞瘤', '威爾姆氏腫瘤',
  '卡波西氏肉瘤', '視網膜母細胞瘤',

  // ── Tier 9: infectious disease ───────────────────────────────────────────
  'COVID-19', '嚴重特殊傳染性肺炎', '登革熱', '瘧疾', '萊姆病', '萊姆病',
  '弓形蟲症', '巨細胞病毒感染', 'EB病毒', '皰疹病毒', '單純皰疹', '帶狀皰疹',
  'HPV', '人類乳突病毒', '諾羅病毒', '輪狀病毒', '霍亂', '破傷風',
  '白喉', '百日咳', '炭疽病', '布魯氏菌病', '退伍軍人病', '李斯特菌',
  '志賀氏菌病', '沙門氏菌感染', '志賀氏桿菌', '念珠菌感染', '隱球菌',
  '麴菌病', '組織胞漿菌病', '小兒麻痺', '日本腦炎', '狂犬病',

  // ── Tier 10: rheumatology / immunology ───────────────────────────────────
  '乾燥症', '硬皮症', '皮肌炎', '多發性肌炎', '血管炎', '巨細胞動脈炎',
  '多發性大動脈炎', '結節性多發性動脈炎', 'Wegener肉芽腫', 'Churg-Strauss症候群',
  '貝賽特氏病', '反應性關節炎', '乾癬性關節炎', '骨關節炎', '骨質疏鬆症',
  '骨軟化症', '佩吉特氏骨病', '先天性免疫缺乏症候群', '常見變異型免疫缺陷',

  // ── Tier 11: ob-gyn ──────────────────────────────────────────────────────
  '子宮肌瘤', '子宮內膜異位症', '子宮腺肌症', '骨盆腔炎', '陰道炎', '子宮頸糜爛',
  '異位妊娠', '葡萄胎', '前置胎盤', '胎盤早期剝離', '妊娠糖尿病', '妊娠高血壓',
  'HELLP症候群', '產後出血', '羊水栓塞', '更年期障礙', '不孕症',

  // ── Tier 12: pediatrics ──────────────────────────────────────────────────
  '唐氏症', '愛德華氏症', '巴陶氏症', '透納氏症', '克氏症候群', '貓哭症候群',
  '威廉氏症候群', '普瑞德威利症候群', '小兒麻痺', '腸絞痛', '幽門狹窄',
  '巨結腸症', '隱睪症', '臍疝氣', '兔唇', '顎裂', '苯酮尿症', '半乳糖血症',
  '楓糖尿症', '高雪氏病', '法布瑞氏症', '注意力不足過動症', '自閉症',
  '兒童虐待',

  // ── Tier 13: psychiatry ──────────────────────────────────────────────────
  '強迫症', '創傷後壓力症候群', '解離性身分疾患', '失眠症', '猝睡症',
  '神經性厭食症', '神經性暴食症', '物質使用疾患', '酒精依賴', '尼古丁依賴',
  '安非他命依賴', '人格疾患', '邊緣性人格疾患', '反社會人格疾患',

  // ── Tier 14: dermatology ─────────────────────────────────────────────────
  '異位性皮膚炎', '接觸性皮膚炎', '脂漏性皮膚炎', '牛皮癬', '玫瑰糠疹',
  '蕁麻疹', '濕疹', '尋常型青春痘', '酒糟鼻', '黃褐斑', '白斑', '雀斑',
  '老年斑', '皮膚癌', '禿頭症', '異常增生',

  // ── Tier 15: pharmacology — antibiotics ──────────────────────────────────
  '青黴素', '頭孢菌素', 'Vancomycin', 'Macrolide', 'Tetracycline', 'Aminoglycoside',
  'Fluoroquinolone', 'Sulfonamide', '甲硝唑', '克林黴素', '抗結核藥物', 'Isoniazid',
  'Rifampicin', '異菸鹼酸醯肼', 'Linezolid',

  // ── Tier 16: pharmacology — cardiovascular ───────────────────────────────
  'Metoprolol', 'Atenolol', 'Carvedilol', 'Amlodipine', 'Verapamil', 'Diltiazem',
  'Lisinopril', 'Enalapril', 'Losartan', 'Valsartan', 'Hydrochlorothiazide',
  'Furosemide', 'Spironolactone', 'Digoxin', 'Amiodarone', 'Adenosine',
  'Warfarin', 'Heparin', 'Dabigatran', 'Rivaroxaban', 'Clopidogrel',
  'Atorvastatin', 'Simvastatin', 'Rosuvastatin', 'Ezetimibe', 'Nitroglycerin',

  // ── Tier 17: pharmacology — endocrine/oncology/immune ────────────────────
  'Metformin', '二甲雙胍', 'Sulfonylurea', 'Sitagliptin', 'GLP-1受體激動劑',
  'SGLT2抑制劑', 'Levothyroxine', '甲巰咪唑', '丙硫氧嘧啶',
  'Methotrexate', 'Cyclophosphamide', 'Cisplatin', 'Doxorubicin', 'Tamoxifen',
  'Imatinib', 'Trastuzumab', 'Rituximab', 'Bevacizumab',
  'Prednisone', 'Dexamethasone', 'Cyclosporine', 'Tacrolimus', 'Azathioprine',
  'Adalimumab', 'Etanercept', 'Infliximab',

  // ── Tier 18: pharmacology — neuro/psych ──────────────────────────────────
  'Phenytoin', 'Carbamazepine', 'Valproate', 'Levetiracetam', 'Lamotrigine',
  'Levodopa', 'Donepezil', 'Memantine', 'Triptan',
  'SSRI', 'Fluoxetine', 'Sertraline', '帕羅西汀', 'Venlafaxine',
  'Haloperidol', 'Risperidone', 'Olanzapine', 'Quetiapine', 'Clozapine',
  'Lithium', 'Benzodiazepine', 'Diazepam', 'Lorazepam', '嗎啡', '芬太尼',

  // ── Tier 19: anatomy/physiology detail ───────────────────────────────────
  '腦幹', '小腦', '大腦皮質', '基底神經節', '丘腦', '下視丘', '腦下垂體',
  '甲狀腺', '副甲狀腺', '腎上腺', '胰臟', '胸腺', '脾臟', '骨髓',
  '冠狀動脈', '主動脈', '上腔靜脈', '下腔靜脈', '門靜脈',
  '腎絲球', '腎元', '腎絲球濾過率', '腎素', '醛固酮',
  '血液循環', '心動週期', '心輸出量', '血壓', '血液',
  '紅血球', '白血球', '血小板', 'B細胞', 'T細胞', '巨噬細胞', '樹突細胞',
  '抗體', '補體系統', '主要組織相容性複合體',
  '神經元', '突觸', '神經傳導物質', '乙醯膽鹼', '多巴胺', '血清素', '正腎上腺素',
  'GABA', '麩胺酸',

  // ── Tier 20: micro & virology detail ────────────────────────────────────
  '革蘭氏染色', '細菌', '病毒', '黴菌', '寄生蟲',
  '鏈球菌', 'A群鏈球菌', '化膿性鏈球菌', '腸球菌',
  '克雷伯氏菌', '綠膿桿菌', '彎曲桿菌', '困難梭狀芽孢桿菌',
  '幽門螺旋桿菌', '梅毒螺旋體', '白色念珠菌', 'B型肝炎病毒', 'C型肝炎病毒',
  'A型肝炎病毒', '人類乳突病毒', 'EB病毒', '巨細胞病毒', '冠狀病毒', '輪狀病毒',
  '小兒麻痺病毒', '人類免疫缺乏病毒', '人類T淋巴細胞病毒',

  // ── Tier 21: lab & diagnostics ───────────────────────────────────────────
  '完整血球計數', '生化檢查', '肝功能檢查', '腎功能檢查', '凝血功能',
  '血糖', '糖化血色素', '血脂肪', '尿酸',
  '腫瘤標記', 'AFP', 'CEA', 'CA-125', 'PSA',
  '尿液檢查', '大便潛血檢查', '心臟超音波', '腹部超音波',
  '冠狀動脈攝影', '上消化道內視鏡', '大腸鏡', '支氣管鏡', '腰椎穿刺',
  '骨髓穿刺', '切片檢查', '抗核抗體', '類風濕因子',

  // ── Tier 22: biochemistry/genetics ───────────────────────────────────────
  '糖原', '脂肪酸', '酮體', '氨基酸', '蛋白質', '酵素', 'ATP',
  '尿素循環', '糖質新生', '戊糖磷酸途徑', '電子傳遞鏈', '氧化磷酸化',
  '基因', '染色體', '突變', '基因表現', '轉錄', '翻譯', 'RNA',
  '癌症基因', '抑癌基因',

  // ── Tier 23: pathology basics ────────────────────────────────────────────
  '壞死', '水腫', '充血', '梗塞', '休克',
  '良性腫瘤', '惡性腫瘤', '癌症轉移', '癌症分期', '癌症化療',
  '放射治療', '免疫療法', '標靶治療',

  // ── Tier 24: dental/oral health ──────────────────────────────────────────
  '牙周病', '齲齒', '蛀牙', '智齒', '牙髓炎', '根尖周圍炎', '齒列矯正',
  '口腔癌', '口角炎', '口腔潰瘍', '阻生齒', '牙根管治療',

  // ── Tier 25: nursing & community health ──────────────────────────────────
  '壓瘡', '靜脈導管', '留置導尿管', '氣管內管', '中央靜脈導管', '心肺復甦',
  '基本救命術', '高級救命術', '哈姆立克法', '疼痛評估', '手部衛生',
  '院內感染', '醫療廢棄物', '隔離病房',

  // ── Tier 26: pharmacy specifics ──────────────────────────────────────────
  '藥物動力學', '藥效學', '半衰期', '生物利用度', '首渡效應',
  '藥物交互作用', '不良藥物反應', '過敏反應', '免疫反應',

  // ── Tier 27: ophthalmology / ENT ────────────────────────────────────────
  '青光眼', '白內障', '黃斑部病變', '視網膜剝離', '近視', '斜視',
  '中耳炎', '外耳炎', '梅尼爾氏症', '突發性耳聾', '耳鳴',
  '鼻竇炎', '過敏性鼻炎', '鼻息肉', '鼻咽癌', '扁桃腺炎',

  // ── Tier 28: orthopedics & rehab ─────────────────────────────────────────
  '骨折', '脫臼', '韌帶撕裂', '半月板撕裂', '骨關節炎', '退化性關節炎',
  '骨質疏鬆症', '椎間盤突出', '坐骨神經痛', '網球肘', '高爾夫球肘', '冰凍肩',
  '腕隧道症候群', '骨髓炎', '化膿性關節炎',
]

async function fetchWikiArticle(title) {
  const params = new URLSearchParams({
    action:        'query',
    format:        'json',
    prop:          'extracts|info|categories',
    titles:        title,
    explaintext:   '1',
    exsectionformat: 'plain',
    inprop:        'url',
    redirects:     '1',
    formatversion: '2',
  })
  const resp = await fetch(`${WIKI_API}?${params}`, {
    headers: { 'User-Agent': 'TaiwanExamRAGBot/1.0 (https://yourdomain.example)' },
  })
  if (!resp.ok) throw new Error(`wiki fetch ${title}: HTTP ${resp.statusCode || resp.status}`)
  const data = await resp.json()
  const page = data.query?.pages?.[0]
  if (!page || page.missing) return null
  if (!page.extract || page.extract.length < 200) return null  // skip stubs
  return {
    title:    page.title,
    url:      page.fullurl,
    content:  page.extract,
    category: page.categories?.[0]?.title?.replace(/^Category:/, '') || 'medicine',
  }
}

async function ingestSeed(title, stats) {
  try {
    const article = await fetchWikiArticle(title)
    if (!article) {
      console.log(`  ✗ ${title}: not found / too short`)
      stats.skipped++
      return
    }
    const result = await rag.ingestDocument({
      source:   'wikipedia_zh',
      url:      article.url,
      title:    article.title,
      language: 'zh',
      category: article.category,
      content:  article.content,
      metadata: { license: 'CC-BY-SA-4.0', attribution: 'Wikipedia 中文' },
    })
    if (result.skipped) {
      console.log(`  · ${title}: already ingested`)
      stats.alreadyIngested++
    } else {
      console.log(`  ✓ ${title}: ${result.chunks} chunks`)
      stats.ingested++
      stats.chunks += result.chunks
    }
  } catch (e) {
    console.log(`  ✗ ${title}: ${e.message}`)
    stats.failed++
  }
}

// Polite rate-limit: 2 req/sec cap to be a good Wikipedia citizen.
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function processSeeds(seeds) {
  const stats = { ingested: 0, alreadyIngested: 0, skipped: 0, failed: 0, chunks: 0 }
  for (let i = 0; i < seeds.length; i++) {
    const t = seeds[i]
    process.stdout.write(`[${i + 1}/${seeds.length}] `)
    await ingestSeed(t, stats)
    await sleep(500)
  }
  console.log('\n--- summary ---')
  console.log(JSON.stringify(stats, null, 2))
}

async function main() {
  const seedsArg = process.argv.includes('--seeds')
  const limitArg = process.argv.find(a => a.startsWith('--limit='))?.slice(8)
  const limit = limitArg ? parseInt(limitArg) : 0

  const seeds = limit ? TAIWAN_EXAM_SEEDS.slice(0, limit) : TAIWAN_EXAM_SEEDS
  if (seedsArg || !process.argv.slice(2).find(a => a.startsWith('--category'))) {
    console.log(`Ingesting ${seeds.length} seed topics from Chinese Wikipedia…\n`)
    await processSeeds(seeds)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
