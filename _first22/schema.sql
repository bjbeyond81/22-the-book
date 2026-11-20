CREATE TABLE IF NOT EXISTS first22 (
  email_key TEXT UNIQUE,
  email TEXT,
  language TEXT NOT NULL CHECK (language IN ('it', 'en')),
  token_hash TEXT UNIQUE,
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  slot INTEGER UNIQUE CHECK (slot BETWEEN 1 AND 22),
  delivered_at INTEGER,
  CHECK ((slot IS NULL) = (confirmed_at IS NULL)),
  CHECK ((email IS NULL) = (email_key IS NULL)),
  CHECK (slot IS NOT NULL OR (email IS NOT NULL AND token_hash IS NOT NULL))
) STRICT;

CREATE INDEX IF NOT EXISTS first22_expiry ON first22 (expires_at);
