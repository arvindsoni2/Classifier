-- Fedora organiser persistence schema (LLD §4).
-- Storage lives outside any organisation root, owner-only access.
-- Foreign keys, WAL journaling and FULL synchronous mode are set by the
-- repository layer on every connection.

CREATE TABLE IF NOT EXISTS roots (
  id TEXT PRIMARY KEY,
  canonical_path TEXT NOT NULL UNIQUE,
  device TEXT NOT NULL,
  inode TEXT NOT NULL,
  policy_revision INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL REFERENCES roots(id),
  stage TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cancellation_requested INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL REFERENCES roots(id),
  external_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  snapshot_json TEXT,
  UNIQUE(root_id, external_id, revision)
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  state_hash TEXT NOT NULL,
  profile TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  private_blob_ref TEXT
);

CREATE TABLE IF NOT EXISTS taxonomy_revisions (
  revision INTEGER PRIMARY KEY,
  approved_at TEXT NOT NULL,
  tree_json TEXT NOT NULL,
  mapping_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  provider TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  runtime_revision TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  token_counts_json TEXT NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  version INTEGER NOT NULL,
  category_id TEXT NOT NULL,
  destination_id TEXT,
  basename TEXT NOT NULL,
  expected_snapshot_json TEXT NOT NULL,
  taxonomy_revision INTEGER NOT NULL,
  policy_revision INTEGER NOT NULL,
  decision_ids_json TEXT NOT NULL,
  state TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  action_set_hash TEXT NOT NULL,
  taxonomy_revision INTEGER NOT NULL,
  policy_revision INTEGER NOT NULL,
  selected_actions_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  mode TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  version INTEGER NOT NULL,
  approval_id TEXT NOT NULL REFERENCES approvals(id),
  mode TEXT NOT NULL,
  state TEXT NOT NULL,
  receipt_json TEXT,
  UNIQUE(proposal_id, version, mode)
);

CREATE TABLE IF NOT EXISTS action_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL REFERENCES actions(id),
  event TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS overrides (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  category_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  active INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS folder_candidates (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  members_json TEXT NOT NULL,
  destination_parent_id TEXT,
  review_state TEXT NOT NULL
);
