-- Catalogue schema, Phase 1 (branch pivot/catalogue-first).
-- Read-only by construction: this database lives in the data directory, never
-- inside a scanned root (spec §7.2), and no table records a write action.
--
-- Integer stat values that can exceed 2^53 (dev, ino, mtime_ns) are stored as
-- decimal strings and read back with bigint:true (plan Task 1).

CREATE TABLE IF NOT EXISTS roots (
  id            INTEGER PRIMARY KEY,
  path          TEXT    NOT NULL UNIQUE,
  dev           TEXT    NOT NULL,
  ino           TEXT    NOT NULL,
  added_at      TEXT    NOT NULL,
  last_scan_id  INTEGER
);

CREATE TABLE IF NOT EXISTS scans (
  id            INTEGER PRIMARY KEY,
  started_at    TEXT    NOT NULL,
  finished_at   TEXT,
  status        TEXT    NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  files_seen    INTEGER NOT NULL DEFAULT 0,
  dirs_seen     INTEGER NOT NULL DEFAULT 0,
  bytes_seen    INTEGER NOT NULL DEFAULT 0,
  files_hashed  INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dirs (
  id               INTEGER PRIMARY KEY,
  root_id          INTEGER NOT NULL REFERENCES roots(id),
  rel_path         TEXT    NOT NULL,
  dev              TEXT    NOT NULL,
  ino              TEXT    NOT NULL,
  file_count       INTEGER,
  dir_count        INTEGER,
  bundle_id        INTEGER,
  last_seen_scan   INTEGER REFERENCES scans(id),
  UNIQUE (root_id, rel_path)
);

CREATE TABLE IF NOT EXISTS items (
  id                 INTEGER PRIMARY KEY,
  root_id            INTEGER NOT NULL REFERENCES roots(id),
  rel_path           TEXT    NOT NULL,
  dir_id             INTEGER REFERENCES dirs(id),
  name               TEXT    NOT NULL,
  ext                TEXT    NOT NULL,
  kind               TEXT    NOT NULL,
  size               INTEGER NOT NULL,
  mtime_ns           TEXT    NOT NULL,
  dev                TEXT    NOT NULL,
  ino                TEXT    NOT NULL,
  nlink              INTEGER,
  partial_hash       TEXT,
  sha256             TEXT,
  bundle_id          INTEGER,
  -- present | missing | incomplete
  status             TEXT    NOT NULL CHECK (status IN ('present', 'missing', 'incomplete')),
  first_seen_scan    INTEGER NOT NULL REFERENCES scans(id),
  last_seen_scan     INTEGER NOT NULL REFERENCES scans(id),
  UNIQUE (root_id, rel_path)
);

-- A bundle is a directory treated as one catalogue unit (plan Task 3):
-- `code_repo` and `code_project` stop the walk, so their contents are never
-- items and member_count/total_size stay null; every other type keeps its
-- members as items carrying bundle_id.
CREATE TABLE IF NOT EXISTS bundles (
  id                INTEGER PRIMARY KEY,
  root_id           INTEGER NOT NULL REFERENCES roots(id),
  rel_path          TEXT    NOT NULL,
  type              TEXT    NOT NULL
    CHECK (type IN ('code_repo', 'code_project', 'course', 'album', 'photo_set', 'extracted_archive')),
  parent_bundle_id  INTEGER REFERENCES bundles(id),
  -- Which rule matched, recorded verbatim so a report can explain the bundle.
  rule              TEXT    NOT NULL,
  member_count      INTEGER,
  total_size        INTEGER,
  detected_scan     INTEGER REFERENCES scans(id),
  UNIQUE (root_id, rel_path)
);

CREATE TABLE IF NOT EXISTS scan_errors (
  id        INTEGER PRIMARY KEY,
  scan_id   INTEGER NOT NULL REFERENCES scans(id),
  root_id   INTEGER NOT NULL REFERENCES roots(id),
  rel_path  TEXT    NOT NULL,
  code      TEXT    NOT NULL,
  message   TEXT    NOT NULL
);

-- Dedupe and reporting read by size and by hash; the scan pass reads a root's
-- current rows by last_seen_scan.
CREATE INDEX IF NOT EXISTS items_by_size  ON items (size);
CREATE INDEX IF NOT EXISTS items_by_sha   ON items (sha256);
CREATE INDEX IF NOT EXISTS items_by_root_status ON items (root_id, status);
CREATE INDEX IF NOT EXISTS items_by_seen  ON items (root_id, last_seen_scan);
CREATE INDEX IF NOT EXISTS dirs_by_scan   ON dirs (root_id, last_seen_scan);
CREATE INDEX IF NOT EXISTS errors_by_scan  ON scan_errors (scan_id);
CREATE INDEX IF NOT EXISTS bundles_by_parent ON bundles (parent_bundle_id);
CREATE INDEX IF NOT EXISTS bundles_by_scan  ON bundles (detected_scan);