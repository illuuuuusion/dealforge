-- Server-side sessions (DF-601): the cookie holds a random token, only its SHA-256 is stored. Logout deletes the row;
-- password_tag binds a session to the APP_PASSWORD it was created with, so changing the password ends every session.
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  password_tag text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  user_agent text
);

-- Audit log (DF-603): every changing API request and every rejected one (401/403/429). Kept 90 days (DF-607).
CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  method text NOT NULL,
  path text NOT NULL,
  status integer NOT NULL,
  ip text,
  user_agent text,
  request_id text
);
CREATE INDEX audit_log_at ON audit_log (at DESC);

-- Outages (DF-606): at most one open incident per subject (worker or provider); a push goes out on open and on resolve.
CREATE TABLE incidents (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject text NOT NULL,
  message text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE UNIQUE INDEX incidents_open ON incidents (subject) WHERE resolved_at IS NULL;

-- Retention purges by age (DF-607).
CREATE INDEX source_runs_started ON source_runs (started_at);
CREATE INDEX listings_last_seen ON listings (last_seen_at);
