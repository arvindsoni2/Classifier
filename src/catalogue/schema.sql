-- Catalogue schema, Phase 1 (branch pivot/catalogue-first).
-- Read-only by construction: this database lives in the data directory, never
-- inside a scanned root (spec §7.2), and no table records a write action.
--
-- Integer stat values that can exceed 2^53 (dev, ino, mtime_ns) are stored as
-- decimal strings and read back with bigint:true (plan Task 1).

-- `roots` carries the volume facts as well as the path (plan Task 1, D31): a
-- root may sit on an external drive that is unplugged, reformatted, or replaced
-- by a different drive at the same path. `dev`/`ino` are kept for the
-- catalogue's history; they are never compared across scans, because a USB
-- drive gets a new device number every time it is plugged in.
--
-- `status` is online|offline, `identity_mode` is inode|path.
CREATE TABLE IF NOT EXISTS roots (
  id               INTEGER PRIMARY KEY,
  path             TEXT    NOT NULL UNIQUE,
  dev              TEXT    NOT NULL,
  ino              TEXT    NOT NULL,
  status           TEXT    CHECK (status IN ('online', 'offline')),
  volume_uuid      TEXT,
  volume_label     TEXT,
  fstype           TEXT,
  mount_point      TEXT,
  is_mount_point   INTEGER,
  identity_mode    TEXT    CHECK (identity_mode IN ('inode', 'path')),
  added_at         TEXT    NOT NULL,
  last_scan_id     INTEGER,
  last_online_at   TEXT
);

-- Which roots a given scan covered, and how each one went. A report needs this to
-- say which drives were included: the same path can be scanned from a different
-- volume from one run to the next. `probe_failed` is not `offline` — the probe
-- could not answer, which says nothing about whether the drive is there.
CREATE TABLE IF NOT EXISTS scan_roots (
  scan_id   INTEGER NOT NULL REFERENCES scans(id),
  root_id   INTEGER NOT NULL REFERENCES roots(id),
  path      TEXT    NOT NULL,
  status    TEXT    NOT NULL CHECK (status IN ('online', 'offline', 'probe_failed')),
  fstype    TEXT,
  PRIMARY KEY (scan_id, root_id)
);

CREATE TABLE IF NOT EXISTS scans (
  id            INTEGER PRIMARY KEY,
  started_at    TEXT    NOT NULL,
  finished_at   TEXT,
  status        TEXT    NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  -- Which part of the pipeline failed: walk, hash, bundles or metadata. A scan
  -- covers the whole pipeline, so "it failed" is only actionable with this.
  failure_stage TEXT,
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

-- One row per item and extractor (plan Task 4). A row is a result, not an
-- action: `fields_json` holds what the extractor read, never a path or a
-- command. `unavailable` means the tool is not on this machine, which is not
-- the same as `failed`; both are retryable on the next scan.
CREATE TABLE IF NOT EXISTS metadata (
  item_id           INTEGER NOT NULL REFERENCES items(id),
  extractor         TEXT    NOT NULL,
  extractor_version TEXT    NOT NULL,
  -- ok | unavailable | failed | timeout
  status            TEXT    NOT NULL
    CHECK (status IN ('ok', 'unavailable', 'failed', 'timeout')),
  fields_json       TEXT    NOT NULL DEFAULT '{}',
  extracted_scan    INTEGER REFERENCES scans(id),
  PRIMARY KEY (item_id, extractor)
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
-- Only inode-mode roots look a file up by inode, to find one that moved; without
-- this index that lookup would scan every item in the root, once per new item.
CREATE INDEX IF NOT EXISTS items_by_identity ON items (root_id, ino);
CREATE INDEX IF NOT EXISTS dirs_by_scan   ON dirs (root_id, last_seen_scan);
CREATE INDEX IF NOT EXISTS errors_by_scan  ON scan_errors (scan_id);
CREATE INDEX IF NOT EXISTS metadata_by_status ON metadata (extractor, status);
CREATE INDEX IF NOT EXISTS bundles_by_parent ON bundles (parent_bundle_id);
CREATE INDEX IF NOT EXISTS bundles_by_scan  ON bundles (detected_scan);