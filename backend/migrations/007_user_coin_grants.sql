-- user_coin_grants: admin-issued personal coin rewards with a message.
--
-- Admin (service role or Dashboard INSERT) creates a row targeting a
-- specific user_id. The frontend polls for unclaimed rows on login,
-- shows a modal, lets the user claim → addCoins + stamp claimed_at.
--
-- Claims are additive (addCoins), so they survive the profile
-- write-through debounce without being overwritten.

CREATE TABLE IF NOT EXISTS user_coin_grants (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  coins INTEGER NOT NULL CHECK (coins > 0),
  reason TEXT NOT NULL,
  from_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_user_coin_grants_unclaimed
  ON user_coin_grants (user_id) WHERE claimed_at IS NULL;

ALTER TABLE user_coin_grants ENABLE ROW LEVEL SECURITY;

-- Recipient can read their own grants.
DROP POLICY IF EXISTS "user_coin_grants_owner_read" ON user_coin_grants;
CREATE POLICY "user_coin_grants_owner_read"
  ON user_coin_grants FOR SELECT
  USING (auth.uid() = user_id);

-- Recipient can stamp claimed_at on their own grants (and only that).
-- Coins / reason / user_id stay immutable from the client side.
DROP POLICY IF EXISTS "user_coin_grants_owner_claim" ON user_coin_grants;
CREATE POLICY "user_coin_grants_owner_claim"
  ON user_coin_grants FOR UPDATE
  USING (auth.uid() = user_id AND claimed_at IS NULL)
  WITH CHECK (auth.uid() = user_id);

-- INSERT goes through service role only (Dashboard / admin script).
