-- Saved photo IDs and queued post operations must never move to a different community.
CREATE TABLE vk_target (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  group_id INTEGER NOT NULL CHECK (group_id > 0)
);
