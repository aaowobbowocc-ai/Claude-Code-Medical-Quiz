/**
 * RAG (retrieval-augmented generation) utilities.
 *
 * Embedding via Vertex AI text-embedding-004 (768 dims, covered by GenAI App
 * Builder credit). Storage in Supabase pgvector (rag_documents/rag_chunks).
 *
 * Designed to be:
 *   - Idempotent: rerunning a scraper skips already-stored URLs.
 *   - Cheap: batches embedding calls (Vertex supports up to 250 instances/req).
 *   - Async-safe: uses upsert on (source, url) to dedupe parallel inserts.
 */

const { GoogleAuth } = require('google-auth-library')
const supabase = require('./supabase')

const VERTEX_PROJECT     = 'gen-lang-client-0502672630'
const VERTEX_REGION      = 'us-central1'
// text-embedding-004 has a known bug: short Chinese text returns the same
// embedding for different inputs. text-multilingual-embedding-002 doesn't.
// Both are 768 dims so the schema is unchanged.
const EMBEDDING_MODEL    = 'text-multilingual-embedding-002'
const EMBEDDING_DIM      = 768
const auth               = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

// ─── Embedding via Vertex AI ───────────────────────────────────────────────
// Vertex predict accepts up to 250 instances per request. Empirically batches
// of 50 are a sweet spot (lower latency variance, smaller blast radius on
// transient errors).
async function embedBatch(texts, taskType = 'RETRIEVAL_DOCUMENT') {
  if (!texts.length) return []
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${EMBEDDING_MODEL}:predict`
  const token = await auth.getAccessToken()
  const body = {
    instances: texts.map(t => ({ content: t, task_type: taskType })),
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error?.message || JSON.stringify(data).slice(0, 200))
      return data.predictions.map(p => p.embeddings.values)
    } catch (e) {
      if (attempt >= 2) throw e
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
    }
  }
}

async function embedAll(texts, batchSize = 10) {
  const out = []
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize)
    const vecs = await embedBatch(batch)
    out.push(...vecs)
  }
  return out
}

// ─── Chunking ──────────────────────────────────────────────────────────────
// Token-aware chunker: 1 CJK char ≈ 1 token, 1 ASCII word ≈ 1 token. Targets
// ~400 tokens per chunk with 80-token overlap for context continuity.
const CHARS_PER_TOKEN = 1.4  // rough avg for mixed CJK/ASCII

function approxTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function chunkText(text, targetTokens = 400, overlapTokens = 80) {
  const targetChars  = Math.floor(targetTokens  * CHARS_PER_TOKEN)
  const overlapChars = Math.floor(overlapTokens * CHARS_PER_TOKEN)
  // Split by paragraph/sentence boundaries first to avoid mid-sentence cuts.
  const paragraphs = text.split(/\n{2,}/).filter(p => p.trim())
  const chunks = []
  let current = ''
  for (const para of paragraphs) {
    if (current.length + para.length + 2 <= targetChars) {
      current += (current ? '\n\n' : '') + para
      continue
    }
    if (current) chunks.push(current)
    // If single paragraph longer than target, split by sentence
    if (para.length > targetChars) {
      const sentences = para.split(/(?<=[。！？\.!?])\s+/)
      let buf = ''
      for (const s of sentences) {
        if (buf.length + s.length + 1 <= targetChars) {
          buf += (buf ? ' ' : '') + s
        } else {
          if (buf) chunks.push(buf)
          buf = s
        }
      }
      current = buf
    } else {
      current = para
    }
  }
  if (current) chunks.push(current)

  // Add overlap by prepending tail of previous chunk to next.
  if (overlapChars > 0 && chunks.length > 1) {
    for (let i = 1; i < chunks.length; i++) {
      const prevTail = chunks[i - 1].slice(-overlapChars)
      chunks[i] = prevTail + '\n…\n' + chunks[i]
    }
  }
  return chunks
}

// ─── Persistence ───────────────────────────────────────────────────────────
async function upsertDocument({ source, url, title, language, category, content, metadata }) {
  const tokens = approxTokens(content)
  const { data, error } = await supabase
    .from('rag_documents')
    .upsert(
      { source, url, title, language, category, content, tokens, metadata: metadata || {}, fetched_at: new Date().toISOString() },
      { onConflict: 'source,url' },
    )
    .select('id')
    .single()
  if (error) throw new Error(`upsertDocument: ${error.message}`)
  return data.id
}

async function documentExists(source, url) {
  const { data } = await supabase
    .from('rag_documents')
    .select('id')
    .eq('source', source).eq('url', url)
    .maybeSingle()
  return data?.id || null
}

async function clearDocumentChunks(documentId) {
  const { error } = await supabase.from('rag_chunks').delete().eq('document_id', documentId)
  if (error) throw new Error(`clearDocumentChunks: ${error.message}`)
}

async function insertChunks(documentId, chunks, embeddings, metadata) {
  const rows = chunks.map((content, idx) => ({
    document_id: documentId,
    chunk_index: idx,
    content,
    embedding: embeddings[idx],
    tokens: approxTokens(content),
    metadata: metadata || {},
  }))
  // Insert in batches to avoid Supabase request size limits.
  const batch = 50
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch)
    const { error } = await supabase.from('rag_chunks').insert(slice)
    if (error) throw new Error(`insertChunks: ${error.message}`)
  }
}

// ingestDocument: end-to-end pipeline for a single document.
// Skips if already ingested (idempotent unless `force: true`).
async function ingestDocument(doc, { force = false } = {}) {
  const existing = await documentExists(doc.source, doc.url)
  if (existing && !force) return { id: existing, skipped: true }

  const chunks = chunkText(doc.content)
  if (!chunks.length) return { skipped: true, reason: 'empty content' }

  const embeddings = await embedAll(chunks)

  const id = await upsertDocument(doc)
  if (existing) await clearDocumentChunks(id)

  await insertChunks(id, chunks, embeddings, {
    title: doc.title, source: doc.source, url: doc.url, category: doc.category, language: doc.language,
  })
  return { id, chunks: chunks.length, embedded: embeddings.length }
}

// ─── Retrieval (used by /explain to inject grounded context) ───────────────
async function retrieve(queryText, { topK = 5, threshold = 0.55, language = null } = {}) {
  const [embedding] = await embedBatch([queryText], 'RETRIEVAL_QUERY')
  // supabase-js sends JS arrays as JSON — Postgres function signature
  // `vector(768)` doesn't auto-cast that. Format as pgvector literal string
  // `[0.01,0.02,...]` so the implicit text→vector cast triggers.
  const vectorLiteral = '[' + embedding.join(',') + ']'
  const { data, error } = await supabase.rpc('rag_match_chunks', {
    query_embedding: vectorLiteral,
    match_threshold: threshold,
    match_count:     topK,
    language_filter: language,
  })
  if (error) { console.warn('retrieve:', error.message); return [] }
  return data || []
}

module.exports = {
  embedBatch, embedAll, chunkText, approxTokens,
  upsertDocument, documentExists, clearDocumentChunks, insertChunks,
  ingestDocument, retrieve,
  EMBEDDING_DIM, EMBEDDING_MODEL,
}
