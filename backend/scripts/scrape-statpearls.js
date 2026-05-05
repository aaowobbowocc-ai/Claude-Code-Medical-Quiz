#!/usr/bin/env node
/**
 * Scrape StatPearls articles from NCBI Bookshelf into the RAG knowledge base.
 *
 * StatPearls is open-access (CC BY-NC-ND 4.0 — non-commercial restriction
 * forbids redistribution; using locally as background context for AI explain
 * is borderline OK but **does not republish content**). We store summarized
 * chunks server-side and inject them into LLM prompts; we never display the
 * raw text to end users. If you ever want to expose chunks directly, switch
 * to a fully permissive source.
 *
 * Pipeline:
 *   1. esearch  db=books term="<topic> statpearls"   → top hit's NCBI ID
 *   2. efetch   db=books id=<id> rettype=fulltext_text  → article body
 *   3. ingest into rag_documents/rag_chunks
 *
 * Run:
 *   node scripts/scrape-statpearls.js                  ingest default topic list
 *   node scripts/scrape-statpearls.js --limit=50       only first 50
 *   node scripts/scrape-statpearls.js --topics=foo,bar ingest specific topics
 */

require('dotenv/config')
const rag = require('../rag')

const NCBI_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
const NCBI_KEY  = process.env.NCBI_API_KEY || ''  // optional; raises rate limit

// Curated topics — chosen for high overlap with Taiwan medical-board exams.
// Ordered roughly by frequency in question banks.
const STATPEARLS_TOPICS = [
  // Cardiology
  'acute myocardial infarction', 'unstable angina', 'heart failure',
  'atrial fibrillation', 'ventricular tachycardia', 'aortic stenosis',
  'mitral regurgitation', 'cardiac tamponade', 'pericarditis',
  'myocarditis', 'infective endocarditis', 'cardiogenic shock',
  'pulmonary embolism', 'deep vein thrombosis', 'aortic dissection',
  'hypertensive crisis',
  // Pulmonology
  'community acquired pneumonia', 'aspiration pneumonia', 'tuberculosis',
  'asthma exacerbation', 'COPD exacerbation', 'pneumothorax',
  'pleural effusion', 'pulmonary edema', 'ARDS',
  'lung cancer', 'sarcoidosis', 'idiopathic pulmonary fibrosis',
  // Endocrinology
  'diabetic ketoacidosis', 'hyperosmolar hyperglycemic state',
  'hypoglycemia', 'thyroid storm', 'myxedema coma', 'Cushing syndrome',
  'Addison disease', 'pheochromocytoma', 'primary hyperaldosteronism',
  'SIADH', 'diabetes insipidus', 'hypercalcemia', 'hypocalcemia',
  'hyperkalemia', 'hypokalemia', 'hyponatremia', 'hypernatremia',
  // Renal
  'acute kidney injury', 'chronic kidney disease', 'glomerulonephritis',
  'nephrotic syndrome', 'IgA nephropathy', 'lupus nephritis',
  'polycystic kidney disease', 'renal cell carcinoma',
  'pyelonephritis', 'urinary tract infection', 'rhabdomyolysis',
  // GI
  'peptic ulcer disease', 'GERD', 'Helicobacter pylori infection',
  'cirrhosis', 'hepatitis B', 'hepatitis C', 'NAFLD',
  'acute pancreatitis', 'cholecystitis', 'cholangitis',
  'inflammatory bowel disease', 'Crohn disease', 'ulcerative colitis',
  'colorectal cancer', 'gastric cancer', 'esophageal cancer',
  'gastrointestinal bleeding', 'small bowel obstruction',
  'appendicitis', 'diverticulitis',
  // Heme/Onc
  'iron deficiency anemia', 'megaloblastic anemia', 'hemolytic anemia',
  'sickle cell disease', 'thalassemia', 'aplastic anemia',
  'acute myeloid leukemia', 'acute lymphoblastic leukemia',
  'chronic myeloid leukemia', 'chronic lymphocytic leukemia',
  'multiple myeloma', 'Hodgkin lymphoma', 'non-Hodgkin lymphoma',
  'breast cancer', 'cervical cancer', 'ovarian cancer',
  'prostate cancer', 'lung cancer screening',
  'thrombocytopenia', 'disseminated intravascular coagulation',
  'von Willebrand disease', 'hemophilia',
  // Infectious disease
  'sepsis', 'septic shock', 'meningitis', 'encephalitis',
  'cellulitis', 'necrotizing fasciitis', 'osteomyelitis',
  'septic arthritis', 'HIV', 'tuberculosis treatment',
  'malaria', 'dengue fever', 'leptospirosis', 'syphilis',
  'gonorrhea', 'chlamydia', 'COVID-19',
  // Neurology
  'ischemic stroke', 'hemorrhagic stroke', 'transient ischemic attack',
  'subarachnoid hemorrhage', 'intracerebral hemorrhage',
  'epilepsy', 'status epilepticus', 'multiple sclerosis',
  'myasthenia gravis', 'Guillain-Barré syndrome',
  'Parkinson disease', 'Alzheimer disease', 'lewy body dementia',
  'amyotrophic lateral sclerosis', 'migraine', 'cluster headache',
  'temporal arteritis', 'idiopathic intracranial hypertension',
  // Rheumatology
  'systemic lupus erythematosus', 'rheumatoid arthritis',
  'ankylosing spondylitis', 'psoriatic arthritis', 'gout',
  'pseudogout', 'osteoarthritis', 'osteoporosis',
  'polymyalgia rheumatica', 'giant cell arteritis',
  'fibromyalgia', 'Sjögren syndrome', 'systemic sclerosis',
  'dermatomyositis', 'polymyositis',
  // Critical care
  'septic shock management', 'mechanical ventilation',
  'ARDS management', 'acid-base disorders', 'metabolic acidosis',
  'metabolic alkalosis', 'respiratory acidosis', 'respiratory alkalosis',
  // OB/GYN
  'preeclampsia', 'eclampsia', 'gestational diabetes',
  'placenta previa', 'placental abruption',
  'ectopic pregnancy', 'postpartum hemorrhage',
  'pelvic inflammatory disease', 'endometriosis',
  'polycystic ovary syndrome', 'menopause',
  // Pediatrics
  'Kawasaki disease', 'pediatric asthma', 'bronchiolitis',
  'croup', 'pertussis', 'measles', 'rubella',
  'congenital heart disease', 'patent ductus arteriosus',
  'hypertrophic pyloric stenosis', 'intussusception',
  'developmental dysplasia hip',
  // ENT/Ophtho
  'otitis media', 'otitis externa', 'sinusitis', 'pharyngitis',
  'glaucoma', 'cataract', 'macular degeneration',
  'retinal detachment', 'diabetic retinopathy',
  // Dermatology
  'psoriasis', 'atopic dermatitis', 'contact dermatitis',
  'cellulitis', 'erysipelas', 'tinea infections',
  'scabies', 'urticaria', 'anaphylaxis',
  'Stevens-Johnson syndrome', 'toxic epidermal necrolysis',
  'melanoma', 'basal cell carcinoma', 'squamous cell carcinoma',
  // Psychiatry
  'major depressive disorder', 'bipolar disorder', 'schizophrenia',
  'generalized anxiety disorder', 'panic disorder',
  'post-traumatic stress disorder', 'obsessive compulsive disorder',
  'borderline personality disorder', 'antisocial personality disorder',
  'alcohol use disorder', 'opioid use disorder', 'delirium', 'dementia',
  // Pharmacology highlights
  'beta blocker overdose', 'calcium channel blocker overdose',
  'acetaminophen toxicity', 'salicylate toxicity',
  'opioid overdose', 'benzodiazepine overdose',
  'serotonin syndrome', 'neuroleptic malignant syndrome',
  'malignant hyperthermia', 'warfarin reversal',
]

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function urlWithKey(base, params) {
  const u = new URLSearchParams(params)
  if (NCBI_KEY) u.set('api_key', NCBI_KEY)
  return `${base}?${u}`
}

// Returns { chapterAccessionId: 'NBK534873', title: '...' } or null.
// esearch in db=books returns SECTION/uid IDs, not chapter NBK IDs.
// We chase down the chapter via esummary's chapteraccessionid field.
async function searchStatPearls(topic) {
  const url = urlWithKey(`${NCBI_BASE}/esearch.fcgi`, {
    db:       'books',
    term:     `"${topic}" AND statpearls[Book]`,
    retmax:   '5',
    retmode:  'json',
  })
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`esearch ${topic}: HTTP ${resp.status}`)
  const data = await resp.json()
  const ids  = data.esearchresult?.idlist || []
  if (!ids.length) return null

  // Resolve uids → chapter accession IDs via esummary
  const sumUrl = urlWithKey(`${NCBI_BASE}/esummary.fcgi`, {
    db: 'books', id: ids.join(','), retmode: 'json',
  })
  const sumResp = await fetch(sumUrl)
  if (!sumResp.ok) return null
  const sumData = await sumResp.json()

  // Pick the first hit that has a chapter accession (sections or chapters both
  // expose chapteraccessionid).
  for (const uid of ids) {
    const r = sumData.result?.[uid]
    if (r?.chapteraccessionid) {
      // Prefer chapter-level title (parent doc) over section title for
      // higher-quality category metadata.
      const chapterTitle = r.bookinfo?.match(/<Parent[^>]+role="document"[^>]*>\s*<Title>([^<]+)<\/Title>/)?.[1]
      return {
        chapterAccessionId: r.chapteraccessionid,
        title: chapterTitle || r.title,
      }
    }
  }
  return null
}

async function fetchArticleText(accessionId) {
  // Plain HTML view; strip tags. The "?report=reader" view doesn't always work
  // for chapter-level IDs, so use the canonical chapter URL.
  const url = `https://www.ncbi.nlm.nih.gov/books/${accessionId}/`
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'TaiwanExamRAGBot/1.0' },
  })
  if (!resp.ok) throw new Error(`fetch ${accessionId}: HTTP ${resp.status}`)
  const html = await resp.text()
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned
}

async function ingestTopic(topic, stats) {
  try {
    const found = await searchStatPearls(topic)
    if (!found) { console.log(`  ✗ ${topic}: no match`); stats.skipped++; return }

    const { chapterAccessionId, title } = found
    const url     = `https://www.ncbi.nlm.nih.gov/books/${chapterAccessionId}/`
    const content = await fetchArticleText(chapterAccessionId)

    if (!content || content.length < 500) {
      console.log(`  ✗ ${topic}: too short (${content?.length || 0} chars)`)
      stats.skipped++
      return
    }

    const result = await rag.ingestDocument({
      source:   'statpearls',
      url,
      title,
      language: 'en',
      category: 'clinical-medicine',
      content:  content.slice(0, 50_000),
      metadata: {
        license:     'CC-BY-NC-ND-4.0',
        attribution: 'StatPearls (NCBI Bookshelf)',
        accession:   chapterAccessionId,
      },
    })
    if (result.skipped) {
      console.log(`  · ${topic}: already ingested`)
      stats.alreadyIngested++
    } else {
      console.log(`  ✓ ${topic} → ${chapterAccessionId} "${title.slice(0,40)}…": ${result.chunks} chunks`)
      stats.ingested++
      stats.chunks += result.chunks
    }
  } catch (e) {
    console.log(`  ✗ ${topic}: ${e.message}`)
    stats.failed++
  }
}

async function main() {
  const limitArg  = process.argv.find(a => a.startsWith('--limit='))?.slice(8)
  const topicsArg = process.argv.find(a => a.startsWith('--topics='))?.slice(9)
  const limit     = limitArg ? parseInt(limitArg) : 0
  const topics    = topicsArg
    ? topicsArg.split(',').map(s => s.trim()).filter(Boolean)
    : (limit ? STATPEARLS_TOPICS.slice(0, limit) : STATPEARLS_TOPICS)

  console.log(`Ingesting ${topics.length} StatPearls topics (NCBI rate-limited 3 req/s)…\n`)
  const stats = { ingested: 0, alreadyIngested: 0, skipped: 0, failed: 0, chunks: 0 }
  for (let i = 0; i < topics.length; i++) {
    process.stdout.write(`[${i + 1}/${topics.length}] `)
    await ingestTopic(topics[i], stats)
    // 350ms pause keeps us under 3 req/s without API key (NCBI tolerates this)
    await sleep(NCBI_KEY ? 110 : 350)
  }
  console.log('\n--- summary ---')
  console.log(JSON.stringify(stats, null, 2))
}

main().catch(e => { console.error(e); process.exit(1) })
