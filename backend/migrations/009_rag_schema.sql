-- Migration 009: Medical/Legal RAG knowledge base
-- Vertex AI text-embedding-004 produces 768-dim vectors.

CREATE EXTENSION IF NOT EXISTS vector;

-- One row per source document (Wikipedia article, StatPearls page, guideline PDF, etc.)
CREATE TABLE IF NOT EXISTS rag_documents (
  id          BIGSERIAL PRIMARY KEY,
  source      TEXT NOT NULL,           -- 'wikipedia_zh' | 'wikipedia_en' | 'statpearls' | 'tw_guideline' | 'who' | 'cdc'
  url         TEXT NOT NULL,
  title       TEXT,
  language    TEXT,                    -- 'zh' | 'en'
  category    TEXT,                    -- specialty / topic
  content     TEXT,                    -- full cleaned text
  tokens      INT,
  metadata    JSONB,
  fetched_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source, url)
);

CREATE INDEX IF NOT EXISTS rag_documents_source_idx   ON rag_documents (source);
CREATE INDEX IF NOT EXISTS rag_documents_language_idx ON rag_documents (language);
CREATE INDEX IF NOT EXISTS rag_documents_category_idx ON rag_documents (category);

-- Chunks for vector retrieval. Each document is split into ~400-800 token chunks
-- with ~100 token overlap.
CREATE TABLE IF NOT EXISTS rag_chunks (
  id            BIGSERIAL PRIMARY KEY,
  document_id   BIGINT REFERENCES rag_documents(id) ON DELETE CASCADE,
  chunk_index   INT NOT NULL,
  content       TEXT NOT NULL,
  embedding     vector(768),
  tokens        INT,
  metadata      JSONB,                 -- doc title/source/etc denormalized for retrieval display
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rag_chunks_document_id_idx ON rag_chunks (document_id);
-- Cosine-similarity ANN index. lists=100 is good for ~100K-1M chunks.
CREATE INDEX IF NOT EXISTS rag_chunks_embedding_idx
  ON rag_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Match-by-similarity RPC for the backend to call.
CREATE OR REPLACE FUNCTION rag_match_chunks(
  query_embedding vector(768),
  match_threshold float DEFAULT 0.5,
  match_count     int   DEFAULT 5,
  language_filter text  DEFAULT NULL
)
RETURNS TABLE (
  id           BIGINT,
  document_id  BIGINT,
  content      TEXT,
  metadata     JSONB,
  similarity   float
)
LANGUAGE sql STABLE AS $$
  SELECT
    c.id,
    c.document_id,
    c.content,
    c.metadata,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM rag_chunks c
  LEFT JOIN rag_documents d ON d.id = c.document_id
  WHERE
    c.embedding IS NOT NULL
    AND (language_filter IS NULL OR d.language = language_filter)
    AND 1 - (c.embedding <=> query_embedding) > match_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;
