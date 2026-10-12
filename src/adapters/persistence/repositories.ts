/**
 * SQLite schema and public repositories (LLD §1/§4).
 *
 * One file, one concern: this module owns durable storage only. Domain and
 * application code read/write through these public contracts and never touch
 * the database directly. Storage sits outside any organisation root with
 * owner-only access; WAL journaling, FULL synchronous mode and foreign keys
 * are enforced on every connection.
 */
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, readFileSync } from 'node:fs';
import type { Id, Item, Proposal, Revision, Sha256, Snapshot } from '../../domain/contracts.js';

export interface RootRecord {
  id: Id;
  canonicalPath: string;
  device: string;
  inode: string;
  policyRevision: Revision;
}

export interface Batch {
  id: Id;
  rootId: Id;
  stage: string;
  createdAt: string;
  cancellationRequested: boolean;
}

/** Event kinds mirror the LLD §6 action state machine. */
export type ActionEventKind =
  | 'planned'
  | 'approved'
  | 'intent'
  | 'applied'
  | 'reconciled'
  | 'conflict'
  | 'stale'
  | 'undo_intent'
  | 'undone'
  // A helper failure whose effect cannot be determined (timeout, transport,
  // post-effect fsync): the record stays non-terminal for reconciliation.
  | 'uncertain_effect';

export interface ActionEvent {
  event: ActionEventKind;
  recordedAt: string;
  payloadJson?: string;
}

export interface WriterLockOwner {
  owner: string;
}

export interface EvidenceRecord {
  id: Id;
  itemId: Id;
  stateHash: string;
  profile: string;
  /** Public audit manifest: hashes and revisions, no private content. */
  manifestJson: string;
  /** The model-facing state, stored locally only (replayable, F10). */
  stateJson: string | null;
}

interface EvidenceRow {
  id: string;
  item_id: string;
  state_hash: string;
  profile: string;
  manifest_json: string;
  state_json: string | null;
}

function mapEvidenceRow(row: EvidenceRow): EvidenceRecord {
  return {
    id: row.id,
    itemId: row.item_id,
    stateHash: row.state_hash,
    profile: row.profile,
    manifestJson: row.manifest_json,
    stateJson: row.state_json,
  };
}

export interface DecisionRecord {
  id: Id;
  itemId: Id;
  provider: string;
  modelRevision: string;
  runtimeRevision: string;
  evidenceHash: string;
  schemaHash: string;
  answersJson: string;
  elapsedMs: number;
  tokenCountsJson: string;
  error: string | null;
}

export interface ActionRecord {
  id: Id;
  proposalId: Id;
  proposalVersion: Revision;
  mode: 'apply' | 'undo';
  approvalId: Id;
  state: string;
  receiptJson: string | null;
  events: ActionEvent[];
  /** Immutable action data captured at intent time (spec review R6). */
  sourceBasename: string | null;
  targetSegments: string[] | null;
  expectedSnapshot: Snapshot | null;
  destinationPin: { destinationId: Id; device: string; inode: string } | null;
}

export interface ActionEventRecord {
  event: ActionEventKind;
  recordedAt: string;
  payloadHash: string;
  payloadJson: string | null;
}

export interface ApprovalRecord {
  id: Id;
  batchId: Id;
  actionSetHash: string;
  taxonomyRevision: Revision;
  policyRevision: Revision;
  selectedActionsJson: string;
  expiresAt: string;
  mode: 'apply' | 'undo';
  /** Root/destination identity captured at approval time (R2). */
  pinsJson: string | null;
}

export interface FolderCandidateRecord {
  id: Id;
  batchId: Id;
  label: string;
  membersJson: string;
  destinationParentId: Id | null;
  reviewState: string;
}

export interface ActionSaveInput {
  id: Id;
  proposalId: Id;
  proposalVersion: Revision;
  mode: 'apply' | 'undo';
  approvalId: Id;
  state: string;
  /** Immutable action data captured at intent time (spec review R6). */
  sourceBasename?: string;
  targetSegments?: string[];
  expectedSnapshot?: Snapshot;
  destinationPin?: { destinationId: Id; device: string; inode: string };
}

export interface Repositories {
  roots: { insert(root: RootRecord): void; get(id: Id): RootRecord | null };
  items: {
    save(item: Item, rootId: Id): void;
    listByRoot(rootId: Id): { item: Item; rootId: Id }[];
    /** Records which items a scan batch actually observed (R12). */
    addToBatch(batchId: Id, itemIds: Id[]): void;
    listByBatch(batchId: Id): { item: Item; rootId: Id }[];
    /** True once ANY scan has recorded membership (legacy-database gate, F7). */
    hasMembership(): boolean;
  };
  batches: {
    create(rootId: Id): Batch;
    get(id: Id): Batch | null;
    requestCancel(id: Id): void;
    listByRoot(rootId: Id): Batch[];
    listAll(): Batch[];
    /** Persists the exclusions a scan observed (R12). */
    addExclusion(batchId: Id, reason: string): void;
    exclusions(batchId: Id): string[];
  };
  proposals: {
    save(proposal: Proposal): void;
    get(id: Id): Proposal | null;
    listByRoot(rootId: Id): Proposal[];
    /** Proposals whose items the batch actually scanned (spec review F7). */
    listByBatch(batchId: Id): Proposal[];
    /** Marks pending proposals bound to an older taxonomy revision stale. */
    markStaleBeforeRevision(revision: Revision): void;
  };
  taxonomies: {
    /** Persists the reviewed taxonomy revision (durable current state). */
    save(revision: Revision, treeJson: string, mappingHash: Sha256, approvedAt: string): void;
    /** The latest persisted revision, or null when none was approved yet. */
    latest(): { revision: Revision; treeJson: string; mappingHash: Sha256 } | null;
  };
  approvals: {
    insert(approval: ApprovalRecord): void;
    get(id: Id): ApprovalRecord | null;
    listByBatch(batchId: Id): ApprovalRecord[];
  };
  actions: {
    save(input: ActionSaveInput): void;
    appendEvent(actionId: Id, event: ActionEvent): void;
    events(actionId: Id): ActionEventRecord[];
    get(actionId: Id): ActionRecord | null;
    find(proposalId: Id, proposalVersion: Revision, mode: 'apply' | 'undo'): ActionRecord | null;
    listByApproval(approvalId: Id): ActionRecord[];
    listByBatch(batchId: Id): ActionRecord[];
    update(actionId: Id, update: { state: string; receiptJson?: string | null }): void;
  };
  /** Removes a retained batch and everything that references it (R12). */
  purgeBatch(batchId: Id): void;
  evidence: {
    save(evidence: EvidenceRecord): void;
    listByRoot(rootId: Id): EvidenceRecord[];
    deleteByItem(itemId: Id): void;
  };
  decisions: {
    save(decision: DecisionRecord): void;
    listByRoot(rootId: Id): { decision: DecisionRecord; rootId: Id }[];
    listByItem(itemId: Id): DecisionRecord[];
    deleteByItem(itemId: Id): void;
  };
  locks: {
    /**
     * Claims the root for one writer (apply/recovery/undo) and returns the
     * owner token to release with, or null when another live owner holds it.
     * A stale owner (crashed process) is taken over. One root, one writer,
     * across every process.
     */
    acquire(rootId: Id, staleAfterMs: number): string | null;
    /** Heartbeat: extends the lease only while this owner still holds it. */
    renew(rootId: Id, owner: string): boolean;
    release(rootId: Id, owner: string): void;
  };
  folderCandidates: {
    insert(candidate: FolderCandidateRecord): void;
    listByBatch(batchId: Id): FolderCandidateRecord[];
    updateState(id: Id, reviewState: string): void;
  };
  transaction<T>(fn: () => T): T;
  close(): void;
}

interface ApprovalRow {
  id: string;
  batch_id: string;
  action_set_hash: string;
  taxonomy_revision: number;
  policy_revision: number;
  selected_actions_json: string;
  expires_at: string;
  mode: string;
  pins_json: string | null;
}

interface DecisionRow {
  id: string;
  item_id: string;
  provider: string;
  model_revision: string;
  runtime_revision: string;
  evidence_hash: string;
  schema_hash: string;
  answers_json: string;
  elapsed_ms: number;
  token_counts_json: string;
  error: string | null;
}

function mapDecisionRow(row: DecisionRow): DecisionRecord {
  return {
    id: row.id,
    itemId: row.item_id,
    provider: row.provider,
    modelRevision: row.model_revision,
    runtimeRevision: row.runtime_revision,
    evidenceHash: row.evidence_hash,
    schemaHash: row.schema_hash,
    answersJson: row.answers_json,
    elapsedMs: row.elapsed_ms,
    tokenCountsJson: row.token_counts_json,
    error: row.error,
  };
}

interface FolderCandidateRow {
  id: string;
  batch_id: string;
  label: string;
  members_json: string;
  destination_parent_id: string | null;
  review_state: string;
}

interface ProposalRow {
  id: string;
  item_id: string;
  version: number;
  category_id: string;
  destination_id: string | null;
  basename: string;
  expected_snapshot_json: string;
  taxonomy_revision: number;
  policy_revision: number;
  decision_ids_json: string;
  state: string;
}

interface ActionRow {
  id: string;
  proposal_id: string;
  version: number;
  approval_id: string;
  mode: string;
  state: string;
  receipt_json: string | null;
  source_basename: string | null;
  target_segments_json: string | null;
  expected_snapshot_json: string | null;
  destination_pin_json: string | null;
}

interface ItemRow {
  id: string;
  root_id: string;
  external_id: string;
  revision: string;
  snapshot_json: string | null;
}

interface EventRow {
  event: string;
  recorded_at: string;
  payload_hash: string;
  payload_json: string | null;
}

function mapItemRow(row: ItemRow): Item {
  return {
    id: row.id,
    sourceId: row.root_id,
    sourceKind: 'filesystem',
    externalId: row.external_id,
    displayName: row.external_id,
    revision: row.revision,
    snapshot:
      row.snapshot_json === null ? ({} as Snapshot) : (JSON.parse(row.snapshot_json) as Snapshot),
    evidenceId: null,
  };
}

function mapProposalRow(row: ProposalRow): Proposal {
  return {
    id: row.id,
    version: row.version,
    itemId: row.item_id,
    categoryId: row.category_id,
    destinationId: row.destination_id ?? '',
    basename: row.basename,
    expected: JSON.parse(row.expected_snapshot_json) as Snapshot,
    taxonomyRevision: row.taxonomy_revision,
    policyRevision: row.policy_revision,
    decisionIds: JSON.parse(row.decision_ids_json) as Id[],
    state: row.state as Proposal['state'],
  };
}

function mapActionRow(row: ActionRow, eventRows: EventRow[]): ActionRecord {
  // The journal retains the payload alongside its hash (spec review R6):
  // recovery must be able to read what was journalled.
  const events: ActionEvent[] = eventRows.map((eventRow) => {
    const event: ActionEvent = {
      event: eventRow.event as ActionEventKind,
      recordedAt: eventRow.recorded_at,
    };
    if (eventRow.payload_json !== null) event.payloadJson = eventRow.payload_json;
    return event;
  });
  return {
    id: row.id,
    proposalId: row.proposal_id,
    proposalVersion: row.version,
    mode: row.mode as 'apply' | 'undo',
    approvalId: row.approval_id,
    state: row.state,
    receiptJson: row.receipt_json,
    events,
    sourceBasename: row.source_basename ?? null,
    targetSegments:
      typeof row.target_segments_json === 'string' ? (JSON.parse(row.target_segments_json) as string[]) : null,
    expectedSnapshot:
      typeof row.expected_snapshot_json === 'string'
        ? (JSON.parse(row.expected_snapshot_json) as Snapshot)
        : null,
    destinationPin:
      typeof row.destination_pin_json === 'string'
        ? (JSON.parse(row.destination_pin_json) as { destinationId: Id; device: string; inode: string })
        : null,
  };
}

export function createRepositories(dbPath: string): Repositories {
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');

  // Owner-only storage file. WAL/SHM sidecars are created by this connection
  // and re-chmod'd so evidence JSON never lands group/world-readable; they
  // live for as long as this single-writer connection does.
  chmodSync(dbPath, 0o600);
  for (const suffix of ['-wal', '-shm']) {
    try {
      chmodSync(`${dbPath}${suffix}`, 0o600);
    } catch {
      // Sidecar not created yet; it inherits these permissions on creation.
    }
  }

  // Detect tables the previous release lacked BEFORE creating them, so the
  // one-time upgrades below can tell "fresh database" from "old database".
  const tableExisted = (name: string): boolean =>
    (db
      .prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?')
      .get('table', name) !== undefined);
  const hadBatchItems = tableExisted('batch_items');

  // Detect a pre-membership database BEFORE the schema runs so the upgrade
  // can reconstruct batch memberships explicitly (spec review F7) instead of
  // leaving an eternal root-wide ambiguity. Fresh databases see the table
  // created with zero rows and skip the backfill.
  const preMembership =
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'batch_items'").get() as
      | { name: string }
      | undefined) === undefined;
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  if (preMembership) {
    // Every batch that predates the membership tables gets the items of its
    // own root: the closest reconstruction of what it scanned. Idempotent and
    // runs at most once per database (the marker is the table itself).
    db.prepare(
      `INSERT OR IGNORE INTO batch_items (batch_id, item_id)
       SELECT b.id, i.id FROM batches b JOIN items i ON i.root_id = b.root_id`,
    ).run();
  }

  // Explicit membership migration (spec review F7): an old database without
  // batch_items gets a one-time reconstruction — each existing batch
  // receives the items of its own root, the closest truthful record of what
  // it scanned. New databases never take this branch, so an empty batch is
  // always genuinely empty.
  if (!hadBatchItems) {
    db.exec(
      `INSERT OR IGNORE INTO batch_items (batch_id, item_id)
       SELECT b.id, i.id FROM batches b JOIN items i ON i.root_id = b.root_id`,
    );
  }
  // Additive migration: databases created before the R2 pins column gain it
  // without losing rows. Existing approvals stay readable and report no pins,
  // which the application treats as "re-approve required", never as a bypass.
  const approvalColumns = db.prepare('PRAGMA table_info(approvals)').all() as { name: string }[];
  if (approvalColumns.length > 0 && !approvalColumns.some((column) => column.name === 'pins_json')) {
    db.exec('ALTER TABLE approvals ADD COLUMN pins_json TEXT');
  }
  // R6 additive migrations: immutable action data, retained event payloads and
  // the root-scoped writer lock. Existing rows keep working: nulls mean
  // "pre-R6 journal", which the application treats as re-approval required.
  const actionColumns = db.prepare('PRAGMA table_info(actions)').all() as { name: string }[];
  for (const [column, ddl] of [
    ['source_basename', 'ALTER TABLE actions ADD COLUMN source_basename TEXT'],
    ['target_segments_json', 'ALTER TABLE actions ADD COLUMN target_segments_json TEXT'],
    ['expected_snapshot_json', 'ALTER TABLE actions ADD COLUMN expected_snapshot_json TEXT'],
    ['destination_pin_json', 'ALTER TABLE actions ADD COLUMN destination_pin_json TEXT'],
  ] as const) {
    if (actionColumns.length > 0 && !actionColumns.some((entry) => entry.name === column)) {
      db.exec(ddl);
    }
  }
  const eventColumns = db.prepare('PRAGMA table_info(action_events)').all() as { name: string }[];
  if (eventColumns.length > 0 && !eventColumns.some((column) => column.name === 'payload_json')) {
    db.exec('ALTER TABLE action_events ADD COLUMN payload_json TEXT');
  }
  db.exec(
    `CREATE TABLE IF NOT EXISTS writer_locks (
       root_id TEXT PRIMARY KEY,
       owner TEXT NOT NULL,
       acquired_at TEXT NOT NULL
     )`,
  );

  const insertRoot = db.prepare(
    // Identity is refreshed on re-resolution; the policy revision stays as
    // first recorded so a later taxonomy review does not silently re-pin the
    // root's policy (approvals invalidate through the taxonomy revision).
    `INSERT INTO roots (id, canonical_path, device, inode, policy_revision)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       device = excluded.device,
       inode = excluded.inode`,
  );
  const getRoot = db.prepare('SELECT * FROM roots WHERE id = ?');
  const insertItem = db.prepare(
    `INSERT OR REPLACE INTO items (id, root_id, external_id, revision, snapshot_json)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertBatch = db.prepare(
    'INSERT INTO batches (id, root_id, stage, created_at, cancellation_requested) VALUES (?, ?, ?, ?, 0)',
  );
  const getBatch = db.prepare('SELECT * FROM batches WHERE id = ?');
  const requestCancelBatch = db.prepare(
    'UPDATE batches SET cancellation_requested = 1 WHERE id = ?',
  );
  const listBatchesByRoot = db.prepare(
    'SELECT * FROM batches WHERE root_id = ? ORDER BY rowid',
  );
  const insertProposal = db.prepare(
    `INSERT INTO proposals (id, item_id, version, category_id, destination_id, basename,
       expected_snapshot_json, taxonomy_revision, policy_revision, decision_ids_json, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       version = excluded.version,
       category_id = excluded.category_id,
       destination_id = excluded.destination_id,
       basename = excluded.basename,
       expected_snapshot_json = excluded.expected_snapshot_json,
       taxonomy_revision = excluded.taxonomy_revision,
       policy_revision = excluded.policy_revision,
       decision_ids_json = excluded.decision_ids_json,
       state = excluded.state
     WHERE proposals.version <= excluded.version
       AND proposals.state <> 'rejected'`,
  );
  // Regeneration replays the deterministic version-1 plan. A stored row at a
  // higher version is a user correction and an explicitly rejected proposal
  // stays rejected until the user removes it: both survive re-classification
  // (spec review R4). The WHERE clauses above enforce that at the writer.
  const markStaleBeforeRevision = db.prepare(
    `UPDATE proposals SET state = 'stale' WHERE taxonomy_revision < ? AND state = 'pending'`,
  );
  const insertTaxonomy = db.prepare(
    `INSERT INTO taxonomy_revisions (revision, approved_at, tree_json, mapping_hash)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(revision) DO UPDATE SET
       approved_at = excluded.approved_at,
       tree_json = excluded.tree_json,
       mapping_hash = excluded.mapping_hash`,
  );
  const latestTaxonomy = db.prepare(
    'SELECT * FROM taxonomy_revisions ORDER BY revision DESC LIMIT 1',
  );
  const getProposal = db.prepare('SELECT * FROM proposals WHERE id = ?');
  const listProposalsByRoot = db.prepare(
    `SELECT p.* FROM proposals p JOIN items i ON i.id = p.item_id
     WHERE i.root_id = ? ORDER BY p.rowid`,
  );
  const listItemsByRoot = db.prepare(
    'SELECT * FROM items WHERE root_id = ? ORDER BY rowid',
  );
  const listItemsByBatch = db.prepare(
    `SELECT i.* FROM items i JOIN batch_items b ON b.item_id = i.id
     WHERE b.batch_id = ? ORDER BY i.rowid`,
  );
  const addBatchItem = db.prepare(
    'INSERT OR IGNORE INTO batch_items (batch_id, item_id) VALUES (?, ?)',
  );
  const anyMembership = db.prepare('SELECT EXISTS(SELECT 1 FROM batch_items) AS any');
  const listProposalsByBatch = db.prepare(
    `SELECT p.* FROM proposals p
     JOIN items i ON i.id = p.item_id
     JOIN batch_items b ON b.item_id = i.id
     WHERE b.batch_id = ? ORDER BY p.rowid`,
  );
  const addBatchExclusion = db.prepare(
    'INSERT INTO batch_exclusions (batch_id, reason) VALUES (?, ?)',
  );
  const listBatchExclusions = db.prepare(
    'SELECT reason FROM batch_exclusions WHERE batch_id = ? ORDER BY rowid',
  );
  const insertApproval = db.prepare(
    `INSERT INTO approvals (id, batch_id, action_set_hash, taxonomy_revision, policy_revision,
       selected_actions_json, expires_at, mode, pins_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );  const getApproval = db.prepare('SELECT * FROM approvals WHERE id = ?');
  const listApprovalsByBatch = db.prepare(
    'SELECT * FROM approvals WHERE batch_id = ? ORDER BY rowid',
  );
  const insertAction = db.prepare(
    `INSERT INTO actions (id, proposal_id, version, approval_id, mode, state, receipt_json,
       source_basename, target_segments_json, expected_snapshot_json, destination_pin_json)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  );
  const getAction = db.prepare('SELECT * FROM actions WHERE id = ?');
  const findAction = db.prepare(
    'SELECT * FROM actions WHERE proposal_id = ? AND version = ? AND mode = ?',
  );
  const listActionsByApproval = db.prepare('SELECT * FROM actions WHERE approval_id = ?');
  const listActionsByBatch = db.prepare(
    `SELECT * FROM actions WHERE approval_id IN (SELECT id FROM approvals WHERE batch_id = ?) ORDER BY rowid`,
  );
  const listAllBatches = db.prepare('SELECT * FROM batches ORDER BY rowid');
  const updateAction = db.prepare(
    'UPDATE actions SET state = ?, receipt_json = COALESCE(?, receipt_json) WHERE id = ?',
  );
  const getEvents = db.prepare(
    // The payload is retained and returned (spec review R6): recovery must be
    // able to read what was journalled, not only its hash.
    'SELECT * FROM action_events WHERE action_id = ? ORDER BY seq',
  );
  const insertEvent = db.prepare(
    'INSERT INTO action_events (action_id, event, recorded_at, payload_hash, payload_json) VALUES (?, ?, ?, ?, ?)',
  );
  const claimLock = db.prepare(
    `INSERT INTO writer_locks (root_id, owner, acquired_at) VALUES (?, ?, ?)
     ON CONFLICT(root_id) DO UPDATE SET owner = excluded.owner, acquired_at = excluded.acquired_at
     WHERE writer_locks.owner = excluded.owner OR writer_locks.acquired_at < ?`,
  );
  const releaseLock = db.prepare('DELETE FROM writer_locks WHERE root_id = ? AND owner = ?');
  const renewLock = db.prepare(
    'UPDATE writer_locks SET acquired_at = ? WHERE root_id = ? AND owner = ?',
  );
  // Additive (F10): pre-F10 databases gain the replayable state column.
  const evidenceColumns = db.prepare('PRAGMA table_info(evidence)').all() as { name: string }[];
  if (evidenceColumns.length > 0 && !evidenceColumns.some((column) => column.name === 'state_json')) {
    db.exec('ALTER TABLE evidence ADD COLUMN state_json TEXT');
  }
  const insertEvidence = db.prepare(
    `INSERT OR REPLACE INTO evidence (id, item_id, state_hash, profile, manifest_json, state_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const listEvidenceByRoot = db.prepare(
    'SELECT e.* FROM evidence e JOIN items i ON i.id = e.item_id WHERE i.root_id = ? ORDER BY e.rowid',
  );
  const deleteEvidenceByItem = db.prepare('DELETE FROM evidence WHERE item_id = ?');
  const deleteDecisionByItem = db.prepare('DELETE FROM decisions WHERE item_id = ?');
  const insertDecision = db.prepare(
    `INSERT OR REPLACE INTO decisions (id, item_id, provider, model_revision, runtime_revision,
       evidence_hash, schema_hash, answers_json, elapsed_ms, token_counts_json, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const listDecisionsByRoot = db.prepare(
    `SELECT d.*, i.root_id as root_id FROM decisions d JOIN items i ON i.id = d.item_id
     WHERE i.root_id = ? ORDER BY d.rowid`,
  );
  const listDecisionsByItem = db.prepare('SELECT * FROM decisions WHERE item_id = ? ORDER BY rowid');
  const insertFolderCandidate = db.prepare(
    `INSERT INTO folder_candidates (id, batch_id, label, members_json, destination_parent_id, review_state)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const listFolderCandidates = db.prepare(
    'SELECT * FROM folder_candidates WHERE batch_id = ? ORDER BY rowid',
  );
  const updateFolderCandidateState = db.prepare(
    'UPDATE folder_candidates SET review_state = ? WHERE id = ?',
  );

  const transaction = <T>(fn: () => T): T => db.transaction(fn)();

  return {
    roots: {
      insert(root) {
        insertRoot.run(
          root.id,
          root.canonicalPath,
          root.device,
          root.inode,
          root.policyRevision,
        );
      },
      get(id) {
        const row = getRoot.get(id) as
          | { id: string; canonical_path: string; device: string; inode: string; policy_revision: number }
          | undefined;
        if (row === undefined) return null;
        return {
          id: row.id,
          canonicalPath: row.canonical_path,
          device: row.device,
          inode: row.inode,
          policyRevision: row.policy_revision,
        };
      },
    },
    items: {
      addToBatch(batchId, itemIds) {
        for (const itemId of itemIds) addBatchItem.run(batchId, itemId);
      },
      listByBatch(batchId) {
        const rows = listItemsByBatch.all(batchId) as ItemRow[];
        return rows.map((row) => ({ item: mapItemRow(row), rootId: row.root_id }));
      },
      hasMembership() {
        const row = anyMembership.get() as { any: number };
        return row.any === 1;
      },
      save(item, rootId) {
        insertItem.run(
          item.id,
          rootId,
          item.externalId,
          item.revision,
          item.snapshot === null ? null : JSON.stringify(item.snapshot),
        );
      },
      listByRoot(rootId) {
        const rows = listItemsByRoot.all(rootId) as ItemRow[];
        return rows.map((row) => ({
          rootId: row.root_id,
          item: {
            id: row.id,
            sourceId: row.root_id,
            sourceKind: 'filesystem' as const,
            externalId: row.external_id,
            displayName: row.external_id,
            revision: row.revision,
            snapshot: row.snapshot_json === null ? null : (JSON.parse(row.snapshot_json) as Snapshot),
            evidenceId: null,
          },
        }));
      },
    },
    taxonomies: {
      save(revision, treeJson, mappingHash, approvedAt) {
        insertTaxonomy.run(revision, approvedAt, treeJson, mappingHash);
      },
      latest() {
        const row = latestTaxonomy.get() as
          | { revision: number; tree_json: string; mapping_hash: string }
          | undefined;
        if (row === undefined) return null;
        return { revision: row.revision, treeJson: row.tree_json, mappingHash: row.mapping_hash };
      },
    },
    batches: {
      create(rootId) {
        const batch: Batch = {
          id: `batch-${randomUUID()}`,
          rootId,
          stage: 'discovery',
          createdAt: new Date().toISOString(),
          cancellationRequested: false,
        };
        insertBatch.run(batch.id, batch.rootId, batch.stage, batch.createdAt);
        return batch;
      },
      get(id) {
        const row = getBatch.get(id) as
          | { id: string; root_id: string; stage: string; created_at: string; cancellation_requested: number }
          | undefined;
        if (row === undefined) return null;
        return {
          id: row.id,
          rootId: row.root_id,
          stage: row.stage,
          createdAt: row.created_at,
          cancellationRequested: row.cancellation_requested !== 0,
        };
      },
      addExclusion(batchId, reason) {
        addBatchExclusion.run(batchId, reason);
      },
      exclusions(batchId) {
        return (listBatchExclusions.all(batchId) as { reason: string }[]).map((row) => row.reason);
      },
      requestCancel(id) {
        requestCancelBatch.run(id);
      },
      listAll() {
        const rows = listAllBatches.all() as {
          id: string;
          root_id: string;
          stage: string;
          created_at: string;
          cancellation_requested: number;
        }[];
        return rows.map((row) => ({
          id: row.id,
          rootId: row.root_id,
          stage: row.stage,
          createdAt: row.created_at,
          cancellationRequested: row.cancellation_requested !== 0,
        }));
      },
      listByRoot(rootId) {
        const rows = listBatchesByRoot.all(rootId) as {
          id: string;
          root_id: string;
          stage: string;
          created_at: string;
          cancellation_requested: number;
        }[];
        return rows.map((row) => ({
          id: row.id,
          rootId: row.root_id,
          stage: row.stage,
          createdAt: row.created_at,
          cancellationRequested: row.cancellation_requested !== 0,
        }));
      },
    },
    proposals: {
      save(proposal) {
        insertProposal.run(
          proposal.id,
          proposal.itemId,
          proposal.version,
          proposal.categoryId,
          proposal.destinationId,
          proposal.basename,
          JSON.stringify(proposal.expected),
          proposal.taxonomyRevision,
          proposal.policyRevision,
          JSON.stringify(proposal.decisionIds),
          proposal.state,
        );
      },
      markStaleBeforeRevision(revision) {
        markStaleBeforeRevision.run(revision);
      },
      get(id) {
        const row = getProposal.get(id) as ProposalRow | undefined;
        if (row === undefined) return null;
        return mapProposalRow(row);
      },
      listByRoot(rootId) {
        const rows = listProposalsByRoot.all(rootId) as ProposalRow[];
        return rows.map(mapProposalRow);
      },
      listByBatch(batchId) {
        const rows = listProposalsByBatch.all(batchId) as ProposalRow[];
        return rows.map(mapProposalRow);
      },
    },
    approvals: {
      insert(approval) {
        insertApproval.run(
          approval.id,
          approval.batchId,
          approval.actionSetHash,
          approval.taxonomyRevision,
          approval.policyRevision,
          approval.selectedActionsJson,
          approval.expiresAt,
          approval.mode,
          approval.pinsJson,
        );
      },
      get(id) {
        const row = getApproval.get(id) as ApprovalRow | undefined;
        if (row === undefined) return null;
        return {
          id: row.id,
          batchId: row.batch_id,
          actionSetHash: row.action_set_hash,
          taxonomyRevision: row.taxonomy_revision,
          policyRevision: row.policy_revision,
          selectedActionsJson: row.selected_actions_json,
          expiresAt: row.expires_at,
          mode: row.mode as 'apply' | 'undo',
          pinsJson: row.pins_json ?? null,
        };
      },
      listByBatch(batchId) {
        const rows = listApprovalsByBatch.all(batchId) as ApprovalRow[];
        return rows.map((row) => ({
          id: row.id,
          batchId: row.batch_id,
          actionSetHash: row.action_set_hash,
          taxonomyRevision: row.taxonomy_revision,
          policyRevision: row.policy_revision,
          selectedActionsJson: row.selected_actions_json,
          expiresAt: row.expires_at,
          mode: row.mode as 'apply' | 'undo',
          pinsJson: row.pins_json ?? null,
        }));
      },
    },
    actions: {
      save(input) {
        insertAction.run(
          input.id,
          input.proposalId,
          input.proposalVersion,
          input.approvalId,
          input.mode,
          input.state,
          input.sourceBasename ?? null,
          input.targetSegments === undefined ? null : JSON.stringify(input.targetSegments),
          input.expectedSnapshot === undefined ? null : JSON.stringify(input.expectedSnapshot),
          input.destinationPin === undefined ? null : JSON.stringify(input.destinationPin),
        );
      },
      appendEvent(actionId, event) {
        const payloadJson = event.payloadJson ?? '';
        const payloadHash = createHash('sha256').update(payloadJson).digest('hex');
        insertEvent.run(actionId, event.event, event.recordedAt, payloadHash, payloadJson);
      },
      events(actionId) {
        const rows = getEvents.all(actionId) as EventRow[];
        return rows.map((row) => ({
          event: row.event as ActionEventKind,
          recordedAt: row.recorded_at,
          payloadHash: row.payload_hash,
          payloadJson: row.payload_json ?? null,
        }));
      },
      get(actionId: Id) {
        const row = getAction.get(actionId) as ActionRow | undefined;
        if (row === undefined) return null;
        return mapActionRow(row, getEvents.all(row.id) as EventRow[]);
      },
      find(proposalId, proposalVersion, mode) {
        const row = findAction.get(proposalId, proposalVersion, mode) as ActionRow | undefined;
        if (row === undefined) return null;
        return mapActionRow(row, getEvents.all(row.id) as EventRow[]);
      },
      listByApproval(approvalId) {
        const rows = listActionsByApproval.all(approvalId) as ActionRow[];
        return rows.map((row) => mapActionRow(row, []));
      },
      listByBatch(batchId) {
        const rows = listActionsByBatch.all(batchId) as ActionRow[];
        return rows.map((row) => mapActionRow(row, getEvents.all(row.id) as EventRow[]));
      },
      update(actionId, update) {
        updateAction.run(update.state, update.receiptJson ?? null, actionId);
      },
    },
    evidence: {
      save(evidence) {
        insertEvidence.run(
          evidence.id,
          evidence.itemId,
          evidence.stateHash,
          evidence.profile,
          evidence.manifestJson,
          evidence.stateJson,
        );
      },
      listByRoot(rootId) {
        return (listEvidenceByRoot.all(rootId) as EvidenceRow[]).map(mapEvidenceRow);
      },
      deleteByItem(itemId) {
        deleteEvidenceByItem.run(itemId);
      },
    },
    decisions: {
      save(decision) {
        insertDecision.run(
          decision.id,
          decision.itemId,
          decision.provider,
          decision.modelRevision,
          decision.runtimeRevision,
          decision.evidenceHash,
          decision.schemaHash,
          decision.answersJson,
          decision.elapsedMs,
          decision.tokenCountsJson,
          decision.error,
        );
      },
      listByRoot(rootId) {
        const rows = listDecisionsByRoot.all(rootId) as (DecisionRow & { root_id: string })[];
        return rows.map((row) => ({ decision: mapDecisionRow(row), rootId: row.root_id }));
      },
      listByItem(itemId) {
        return (listDecisionsByItem.all(itemId) as DecisionRow[]).map(mapDecisionRow);
      },
      deleteByItem(itemId) {
        deleteDecisionByItem.run(itemId);
      },
    },
    locks: {
      acquire(rootId, staleAfterMs) {
        const owner = `writer-${randomUUID()}`;
        const acquiredAt = new Date().toISOString();
        const staleBefore = new Date(Date.now() - staleAfterMs).toISOString();
        return transaction(() => {
          // INSERT ... ON CONFLICT only takes over a stale lock, so a second
          // live writer never steals the root.
          const result = claimLock.run(rootId, owner, acquiredAt, staleBefore);
          return result.changes === 1 ? owner : null;
        });
      },
      renew(rootId, owner) {
        const result = renewLock.run(new Date().toISOString(), rootId, owner);
        return result.changes === 1;
      },
      release(rootId, owner) {
        releaseLock.run(rootId, owner);
      },
    },
    folderCandidates: {
      insert(candidate) {
        insertFolderCandidate.run(
          candidate.id,
          candidate.batchId,
          candidate.label,
          candidate.membersJson,
          candidate.destinationParentId,
          candidate.reviewState,
        );
      },
      listByBatch(batchId) {
        const rows = listFolderCandidates.all(batchId) as FolderCandidateRow[];
        return rows.map((row) => ({
          id: row.id,
          batchId: row.batch_id,
          label: row.label,
          membersJson: row.members_json,
          destinationParentId: row.destination_parent_id,
          reviewState: row.review_state,
        }));
      },
      updateState(id, reviewState) {
        updateFolderCandidateState.run(reviewState, id);
      },
    },
    transaction,
    purgeBatch(batchId) {
      transaction(() => {
        // Distinct retention periods (spec review F10): the classification
        // PAYLOADS of an out-of-window batch expire, while the action journal,
        // approvals, proposals and items remain — an applied action must stay
        // undoable and auditable. Batch bookkeeping goes with the payloads.
        const itemRows = listItemsByBatch.all(batchId) as ItemRow[];
        for (const row of itemRows) {
          deleteEvidenceByItem.run(row.id);
          deleteDecisionByItem.run(row.id);
        }
        // Membership stays: it is the join that keeps the execution journal
        // batch-queryable (and its absence would make purged batches lie
        // about membership). Only the exclusion TEXT goes: the reasons quote
        // private basenames.
        db.prepare('DELETE FROM batch_exclusions WHERE batch_id = ?').run(batchId);
      });
    },    close() {
      db.close();
    },
  };
}
