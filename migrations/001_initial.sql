CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
CREATE TABLE galleries (
  id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  page_count INTEGER NOT NULL CHECK(page_count >= 13), tags TEXT NOT NULL
);
CREATE TABLE drafts (
  id TEXT PRIMARY KEY, gallery_id TEXT NOT NULL REFERENCES galleries(id),
  version INTEGER NOT NULL DEFAULT 1, fields TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('preparing','ready','invalid','expired','confirmed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE assets (
  id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), page INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','deleted')),
  source_kind TEXT, mime TEXT, width INTEGER, height INTEGER, bytes INTEGER,
  source_sha256 TEXT, final_sha256 TEXT, path TEXT, deleted_at TEXT
);
CREATE TABLE draft_assets (
  draft_id TEXT NOT NULL REFERENCES drafts(id), role TEXT NOT NULL CHECK(role IN ('public','donut')),
  position INTEGER NOT NULL, asset_id TEXT NOT NULL REFERENCES assets(id),
  PRIMARY KEY(draft_id, role, position), UNIQUE(draft_id, asset_id)
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, draft_id TEXT NOT NULL UNIQUE REFERENCES drafts(id),
  gallery_id TEXT NOT NULL REFERENCES galleries(id), snapshot TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','publishing','retry_wait','partial','needs_attention','completed','cancelled')),
  confirmed_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_error TEXT
);
CREATE TABLE confirmation_keys (
  key TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), fingerprint TEXT NOT NULL
);
CREATE TABLE posts (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
  role TEXT NOT NULL CHECK(role IN ('public','donut')), state TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]', operation_key TEXT NOT NULL UNIQUE,
  post_id TEXT, post_url TEXT, last_error TEXT, UNIQUE(job_id, role)
);
CREATE TABLE attempts (
  id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id), operation TEXT NOT NULL,
  state TEXT NOT NULL, request TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE schedule_slots (
  instant TEXT PRIMARY KEY, job_id TEXT REFERENCES jobs(id), result TEXT NOT NULL
);
CREATE INDEX jobs_queue ON jobs(state, confirmed_at);
CREATE INDEX jobs_gallery ON jobs(gallery_id, confirmed_at);
CREATE INDEX assets_draft ON assets(draft_id);
CREATE INDEX drafts_expiry ON drafts(state, expires_at);
