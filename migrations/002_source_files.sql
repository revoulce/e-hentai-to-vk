ALTER TABLE assets ADD COLUMN source_mime TEXT;
ALTER TABLE assets ADD COLUMN source_bytes INTEGER;
ALTER TABLE assets ADD COLUMN source_width INTEGER;
ALTER TABLE assets ADD COLUMN source_height INTEGER;
ALTER TABLE assets ADD COLUMN source_path TEXT;

UPDATE assets SET source_mime = mime, source_bytes = bytes, source_width = width, source_height = height;
