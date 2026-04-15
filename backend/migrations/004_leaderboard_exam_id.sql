-- Per-exam tracking on weekly leaderboard (Plan D.5).
--
-- Adds `exam_id` to record which exam a player's latest score came from.
-- Used to:
--   1. Filter /leaderboard?category=medical|law-professional|civil-service
--   2. Display 主修 badge next to player name (exam_id → category → color)
--   3. Split PR-vs-score display mode for quota-based exams (civil-service)
--
-- Dedup key stays (week, name) — the column tracks the LAST played exam that
-- week, not per-exam row granularity. Upsert updates this field on every score
-- submission. Rows predating the migration have NULL exam_id; they are treated
-- as legacy/medical when no filter is active and excluded from category-specific
-- queries.

ALTER TABLE leaderboard
  ADD COLUMN IF NOT EXISTS exam_id TEXT;

CREATE INDEX IF NOT EXISTS idx_leaderboard_week_exam
  ON leaderboard (week, exam_id) WHERE exam_id IS NOT NULL;
