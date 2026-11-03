-- Market values are computed from listings + snapshots per model (incl. VRAM variant), condition and source.
CREATE INDEX listings_market ON listings (model_key, health, last_seen_at DESC);

-- Personal false-hit feedback: one label per listing; a reported listing leaves the feed.
CREATE TABLE feedback (
  listing_id integer PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (label IN ('wrong_model', 'accessory', 'wrong_condition', 'other')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Ranking weights (0..3 per part) and the minimum sample for a market value. Single user: one row.
CREATE TABLE ranking_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  freshness numeric(4,2) NOT NULL DEFAULT 1,
  price numeric(4,2) NOT NULL DEFAULT 1,
  repair numeric(4,2) NOT NULL DEFAULT 1,
  market numeric(4,2) NOT NULL DEFAULT 1,
  personal numeric(4,2) NOT NULL DEFAULT 1,
  market_min_sample integer NOT NULL DEFAULT 20 CHECK (market_min_sample >= 5)
);
INSERT INTO ranking_settings DEFAULT VALUES;
