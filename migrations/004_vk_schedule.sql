-- Keep all child references intact while expanding the job state constraint.
CREATE TABLE jobs_next (
  id TEXT PRIMARY KEY, draft_id TEXT NOT NULL UNIQUE REFERENCES drafts(id),
  gallery_id TEXT NOT NULL REFERENCES galleries(id), snapshot TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','publishing','retry_wait','partial','needs_attention','scheduled','completed','cancelled')),
  confirmed_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_error TEXT
);
INSERT INTO jobs_next SELECT * FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_next RENAME TO jobs;
CREATE INDEX jobs_queue ON jobs(state, confirmed_at);
CREATE INDEX jobs_gallery ON jobs(gallery_id, confirmed_at);
ALTER TABLE posts ADD COLUMN publish_at TEXT;
CREATE INDEX posts_schedule ON posts(publish_at);
