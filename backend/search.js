/**
 * Vertex AI Search backend — wraps the discoveryengine.googleapis.com Search API.
 *
 * Three endpoints share the same underlying search call, just with different
 * query construction + result post-processing:
 *
 *   POST /search/questions  — full-text search (#2)
 *      body: { q, limit=20, examFilter?, yearFilter? }
 *      → returns hits with question_id, exam_id, snippet, subject_name, year
 *
 *   POST /search/similar    — find similar questions (#4)
 *      body: { question_id, exam_id, limit=5 }
 *      → uses the source question's content as the query
 *
 *   POST /search/rag        — RAG retrieval (#3, internal — called by /explain)
 *      body: { text, limit=3 }
 *      → returns top-k question contents + answers as RAG context blocks
 *
 * All three SKUs are covered by the GenAI App Builder credit.
 *
 * Setup: see docs/VERTEX_AI_SEARCH_SETUP.md. Endpoints return 503
 * "search_not_configured" until VERTEX_SEARCH_DATASTORE_ID is set in env.
 */
const https = require('https')
const { GoogleAuth } = require('google-auth-library')

const PROJECT = process.env.VERTEX_PROJECT || 'gen-lang-client-0502672630'
const LOCATION = process.env.VERTEX_SEARCH_LOCATION || 'global'
const DATASTORE_ID = process.env.VERTEX_SEARCH_DATASTORE_ID || ''
const ENGINE_ID = process.env.VERTEX_SEARCH_ENGINE_ID || ''

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const CONFIGURED = !!DATASTORE_ID

/**
 * Low-level Vertex AI Search call.
 * @param {string} query - search query text
 * @param {object} opts
 *   pageSize: result count (default 10)
 *   filter:   Vertex AI Search filter expression (e.g. 'exam_id:"doctor1"')
 *   spell:    'AUTO' | 'NONE' (default AUTO)
 */
async function searchRaw(query, opts = {}) {
  if (!CONFIGURED) throw new Error('search_not_configured')
  const token = await auth.getAccessToken()
  // The serving config path differs based on whether an Engine is wired up;
  // engine path is more standard, falls back to data-store-level config if not.
  const servingConfig = ENGINE_ID
    ? `projects/${PROJECT}/locations/${LOCATION}/collections/default_collection/engines/${ENGINE_ID}/servingConfigs/default_search`
    : `projects/${PROJECT}/locations/${LOCATION}/collections/default_collection/dataStores/${DATASTORE_ID}/servingConfigs/default_search`
  const body = JSON.stringify({
    query,
    pageSize: opts.pageSize || 10,
    queryExpansionSpec: { condition: 'AUTO' },
    spellCorrectionSpec: { mode: opts.spell || 'AUTO' },
    contentSearchSpec: {
      snippetSpec: { returnSnippet: true, maxSnippetCount: 1 },
    },
    ...(opts.filter ? { filter: opts.filter } : {}),
  })

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'discoveryengine.googleapis.com',
      path: `/v1/${servingConfig}:search`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${token}`,
      },
    }, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(Object.assign(new Error(`search HTTP ${res.statusCode}: ${data.slice(0, 200)}`), { status: res.statusCode }))
        }
        try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// Reshape Vertex AI Search response into a thin frontend-friendly array.
//
// Snippet fallback: Vertex AI Search sometimes returns the literal string
// "No snippet is available for this page." for short structured docs. In that
// case (or when no snippet at all) we cut the first ~160 chars of the stored
// content field so the UI always has something to render.
function shapeHits(resp) {
  return (resp.results || []).map(r => {
    const struct = r.document?.structData || {}
    let snippet = r.document?.derivedStructData?.snippets?.[0]?.snippet
      || r.document?.derivedStructData?.snippet
      || ''
    if (!snippet || /^No snippet is available/i.test(snippet)) {
      const c = String(struct.content || '').replace(/\s+/g, ' ').trim()
      snippet = c.length > 160 ? c.slice(0, 160) + '…' : c
    }
    return {
      id: r.document?.id,
      exam_id: struct.exam_id,
      exam_name: struct.exam_name,
      question_id: struct.question_id,
      roc_year: struct.roc_year,
      session: struct.session,
      subject_name: struct.subject_name,
      number: struct.number,
      answer: struct.answer,
      // Full question stem + options (joined). Lets the search page render
      // the question detail inline without a second round-trip to /meta.
      content: String(struct.content || ''),
      snippet,
    }
  })
}

function registerSearchRoutes(app, examData) {
  if (!CONFIGURED) {
    console.log('[search] Vertex AI Search 未設定 (VERTEX_SEARCH_DATASTORE_ID 空) — endpoints 將回 503')
  } else {
    console.log(`[search] Vertex AI Search 就緒：datastore=${DATASTORE_ID.slice(0, 30)}…`)
  }

  // GET /search/health — quick check; useful for deploy smoke test
  app.get('/search/health', (req, res) => {
    res.json({
      configured: CONFIGURED,
      datastore: DATASTORE_ID ? DATASTORE_ID.slice(0, 30) + '…' : null,
      engine: ENGINE_ID ? ENGINE_ID.slice(0, 30) + '…' : null,
    })
  })

  // POST /search/questions
  app.post('/search/questions', async (req, res) => {
    if (!CONFIGURED) return res.status(503).json({ error: 'search_not_configured' })
    const { q, limit, examFilter, yearFilter } = req.body || {}
    if (!q || typeof q !== 'string' || q.trim().length < 1) {
      return res.status(400).json({ error: 'missing_query' })
    }
    const filters = []
    if (examFilter) filters.push(`exam_id:ANY("${String(examFilter).replace(/"/g, '')}")`)
    if (yearFilter) filters.push(`roc_year:ANY("${String(yearFilter).replace(/"/g, '')}")`)
    try {
      const resp = await searchRaw(q.trim().slice(0, 500), {
        pageSize: Math.min(Math.max(parseInt(limit) || 20, 1), 50),
        filter: filters.length ? filters.join(' AND ') : undefined,
      })
      res.json({ hits: shapeHits(resp), totalSize: resp.totalSize || 0 })
    } catch (e) {
      console.warn('[search/questions]', e.message)
      res.status(500).json({ error: 'search_failed', detail: e.message })
    }
  })

  // POST /search/similar
  // Pulls the source question's text from examData, queries Vertex AI Search
  // with that as the query, and filters out the source question itself.
  app.post('/search/similar', async (req, res) => {
    if (!CONFIGURED) return res.status(503).json({ error: 'search_not_configured' })
    const { question_id, exam_id, limit } = req.body || {}
    if (!question_id || !exam_id) return res.status(400).json({ error: 'missing_fields' })
    const bank = examData[exam_id]
    if (!bank?.questions) return res.status(404).json({ error: 'exam_not_found' })
    const q = bank.questions.find(x => String(x.id) === String(question_id))
    if (!q) return res.status(404).json({ error: 'question_not_found' })
    const queryText = (q.question || '').slice(0, 500)
    try {
      const resp = await searchRaw(queryText, {
        pageSize: (Math.min(Math.max(parseInt(limit) || 5, 1), 10)) + 1, // +1 to drop self
        filter: `exam_id:ANY("${exam_id}")`,
      })
      const hits = shapeHits(resp).filter(h => h.question_id !== String(question_id))
      res.json({ hits: hits.slice(0, parseInt(limit) || 5) })
    } catch (e) {
      console.warn('[search/similar]', e.message)
      res.status(500).json({ error: 'search_failed', detail: e.message })
    }
  })

  // Internal: RAG retrieval helper, called by /explain when grounding on
  // own corpus is preferred over Google Search. Returns plain context strings.
  async function ragRetrieve(text, limit = 3) {
    if (!CONFIGURED) return []
    try {
      const resp = await searchRaw(String(text).slice(0, 500), { pageSize: limit })
      return shapeHits(resp).map(h => ({
        snippet: h.snippet,
        subject: h.subject_name,
        year: h.roc_year,
        answer: h.answer,
      }))
    } catch {
      return []
    }
  }

  return { ragRetrieve }
}

module.exports = { registerSearchRoutes, CONFIGURED }
