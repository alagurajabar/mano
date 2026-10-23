CREATE TABLE google_oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE INDEX google_oauth_states_expiry_idx ON google_oauth_states (expires_at);
