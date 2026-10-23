CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE drive_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT,
  photo_url TEXT,
  encrypted_access_token TEXT,
  encrypted_refresh_token TEXT,
  token_expires_at TEXT,
  storage_used_bytes INTEGER,
  storage_total_bytes INTEGER,
  connection_status TEXT NOT NULL DEFAULT 'connected'
    CHECK (connection_status IN ('connected', 'reauth_required', 'disconnected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, email)
);

CREATE TABLE virtual_folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_folder_id TEXT REFERENCES virtual_folders(id) ON DELETE CASCADE,
  drive_account_id TEXT REFERENCES drive_accounts(id) ON DELETE SET NULL,
  google_drive_folder_id TEXT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, parent_folder_id, name)
);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  virtual_folder_id TEXT REFERENCES virtual_folders(id) ON DELETE SET NULL,
  drive_account_id TEXT REFERENCES drive_accounts(id) ON DELETE SET NULL,
  google_drive_file_id TEXT,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  checksum TEXT,
  status TEXT NOT NULL DEFAULT 'complete'
    CHECK (status IN ('pending', 'uploading', 'complete', 'failed', 'deleted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES virtual_folders(id) ON DELETE CASCADE,
  share_token_hash TEXT NOT NULL UNIQUE,
  allow_download INTEGER NOT NULL DEFAULT 1 CHECK (allow_download IN (0, 1)),
  password_hash TEXT,
  expires_at TEXT,
  disabled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((file_id IS NOT NULL AND folder_id IS NULL) OR
         (file_id IS NULL AND folder_id IS NOT NULL))
);

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  drive_account_id TEXT NOT NULL REFERENCES drive_accounts(id) ON DELETE RESTRICT,
  encrypted_resumable_url TEXT,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
  uploaded_bytes INTEGER NOT NULL DEFAULT 0 CHECK (uploaded_bytes >= 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'uploading', 'paused', 'complete', 'failed', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE download_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  share_id TEXT REFERENCES shares(id) ON DELETE SET NULL,
  bytes_sent INTEGER NOT NULL DEFAULT 0 CHECK (bytes_sent >= 0),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX drive_accounts_user_idx ON drive_accounts (user_id);
CREATE INDEX virtual_folders_parent_idx ON virtual_folders (user_id, parent_folder_id);
CREATE INDEX files_user_folder_idx ON files (user_id, virtual_folder_id);
CREATE INDEX files_drive_id_idx ON files (drive_account_id, google_drive_file_id);
CREATE INDEX shares_token_idx ON shares (share_token_hash);
CREATE INDEX upload_sessions_user_status_idx ON upload_sessions (user_id, status);
CREATE INDEX download_logs_file_created_idx ON download_logs (file_id, created_at);

CREATE TABLE sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
