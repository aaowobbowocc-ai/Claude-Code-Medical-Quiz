-- Migration 010: Replace ivfflat with HNSW for rag_chunks
--
-- ivfflat needs training data BEFORE creation (centroids are picked from
-- existing rows). We created the index on an empty table → centroids were
-- arbitrary, returning the same wrong subset for every query.
--
-- HNSW doesn't need pre-training. Slightly higher build cost but much better
-- accuracy at small scale, and recommended default in pgvector ≥0.5.

DROP INDEX IF EXISTS rag_chunks_embedding_idx;

-- m=16, ef_construction=64 are pgvector defaults; safe for ≤1M chunks.
CREATE INDEX rag_chunks_embedding_idx
  ON rag_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Refresh planner stats so the new index is preferred
ANALYZE rag_chunks;
