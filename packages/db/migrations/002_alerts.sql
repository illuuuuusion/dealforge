-- One row per alert event. dedupe_key makes repeated jobs and replays idempotent: at most one first alert
-- per listing, watchlist and kind; PRICE_DROP once per new price level. Alerts outlive a deleted watchlist.
CREATE TABLE alerts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id integer NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  watchlist_id integer REFERENCES watchlists(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('SCHNAPPER', 'DEAL', 'REPAIR', 'PRICE_DROP')),
  dedupe_key text NOT NULL UNIQUE,
  priority integer NOT NULL,
  reasons jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alerts_listing ON alerts (listing_id);
