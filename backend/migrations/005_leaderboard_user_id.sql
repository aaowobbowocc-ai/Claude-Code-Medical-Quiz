-- Link leaderboard rows to auth.users so we can surface per-player
-- achievements (legal_guardian etc.) next to names on the leaderboard.
--
-- user_id is nullable — anonymous / pre-auth users still submit scores,
-- they just won't show a badge. The dedup key stays (week, name); user_id
-- is ancillary metadata updated on each submission.

ALTER TABLE leaderboard
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_leaderboard_user
  ON leaderboard (user_id) WHERE user_id IS NOT NULL;
