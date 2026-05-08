-- coin_orders: track coin top-up orders (currently 街口/JKOPay).
--
-- Flow:
--   1. Frontend POST /payment/jkos/create-order → backend creates row (status=pending)
--      and calls JKOPay API to get payment URL.
--   2. User pays via JKOPay app/web.
--   3. JKOPay POSTs to our webhook → status=paid + insert user_coin_grants row.
--   4. User opens app → unclaimed grant appears → click claim → coins added.
--
-- Why row in coin_orders + row in user_coin_grants (two tables):
--   - coin_orders is the immutable financial ledger (audit, refund, reconcile).
--   - user_coin_grants is the redemption mechanism (debounce-safe coin add).

CREATE TABLE IF NOT EXISTS coin_orders (
  id BIGSERIAL PRIMARY KEY,
  order_id TEXT UNIQUE NOT NULL,            -- our generated UUID (sent to JKOPay as platform_order_id)
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,  -- nullable for anonymous (device-only) users
  device_id TEXT,                           -- localStorage device id for anonymous
  provider TEXT NOT NULL DEFAULT 'jkos',    -- jkos / future: linepay / stripe...
  tier TEXT NOT NULL,                       -- 'small' | 'medium' | 'large'
  amount_twd INTEGER NOT NULL CHECK (amount_twd > 0),
  coins INTEGER NOT NULL CHECK (coins > 0),
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | failed | refunded | expired
  provider_order_id TEXT,                   -- JKOPay's jkos_order_id
  payment_url TEXT,                         -- redirect URL for user to pay
  paid_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  refund_reason TEXT,
  raw_callback JSONB,                       -- full webhook payload for audit
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_status CHECK (status IN ('pending','paid','failed','refunded','expired'))
);

CREATE INDEX IF NOT EXISTS idx_coin_orders_user ON coin_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_coin_orders_status ON coin_orders(status);
CREATE INDEX IF NOT EXISTS idx_coin_orders_provider_order ON coin_orders(provider_order_id);

-- RLS: user can read their own orders; INSERT/UPDATE goes through service role.
ALTER TABLE coin_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coin_orders_owner_read" ON coin_orders;
CREATE POLICY "coin_orders_owner_read"
  ON coin_orders FOR SELECT
  USING (auth.uid() = user_id);
