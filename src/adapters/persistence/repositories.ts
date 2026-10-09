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
import type { Id, Item, Proposal, Revision, Snapshot } from '../../domain/contracts.js';

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
  | 'undone';

export interface ActionEvent {
  event: ActionEventKind;
  recordedAt: string;
  payloadJson?: string;
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
}

export interface Repositories {
  roots: { insert(root: RootRecord): void; get(id: Id): RootRecord | null };
  items: { save(item: Item, rootId: Id): void };
  batches: {
    create(rootId: Id): Batch;
    get(id: Id): Batch | null;
    requestCancel(id: Id): void;
    listByRoot(rootId: Id): Batch[];
  };
  proposals: { save(proposal: Proposal): void; get(id: Id): Proposal | null };
  approvals: {
    insert(approval: ApprovalRecord): void;
    get(id: Id): ApprovalRecord | null;
    listByBatch(batchId: Id): ApprovalRecord[];
  };
  actions: {
    save(input: ActionSaveInput): void;
    appendEvent(actionId: Id, event: ActionEvent): void;
    get(actionId: Id): ActionRecord | null;
    find(proposalId: Id, proposalVersion: Revision, mode: 'apply' | 'undo'): ActionRecord | null;
    listByApproval(approvalId: Id): ActionRecord[];
    update(actionId: Id, update: { state: string; receiptJson?: string | null }): void;
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
}

interface EventRow {
  event: string;
  recorded_at: string;
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

  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

  const insertRoot = db.prepare(
    `INSERT INTO roots (id, canonical_path, device, inode, policy_revision)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       device = excluded.device,
       inode = excluded.inode,
       policy_revision = excluded.policy_revision`,
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
       state = excluded.state`,
  );
  const getProposal = db.prepare('SELECT * FROM proposals WHERE id = ?');
  const insertApproval = db.prepare(
    `INSERT INTO approvals (id, batch_id, action_set_hash, taxonomy_revision, policy_revision,
       selected_actions_json, expires_at, mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );  const getApproval = db.prepare('SELECT * FROM approvals WHERE id = ?');
  const listApprovalsByBatch = db.prepare(
    'SELECT * FROM approvals WHERE batch_id = ? ORDER BY rowid',
  );
  const insertAction = db.prepare(
    `INSERT INTO actions (id, proposal_id, version, approval_id, mode, state, receipt_json)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  );
  const getAction = db.prepare('SELECT * FROM actions WHERE id = ?');
  const findAction = db.prepare(
    'SELECT * FROM actions WHERE proposal_id = ? AND version = ? AND mode = ?',
  );
  const listActionsByApproval = db.prepare('SELECT * FROM actions WHERE approval_id = ?');
  const updateAction = db.prepare(
    'UPDATE actions SET state = ?, receipt_json = COALESCE(?, receipt_json) WHERE id = ?',
  );
  const getEvents = db.prepare(
    'SELECT event, recorded_at FROM action_events WHERE action_id = ? ORDER BY seq',
  );
  const insertEvent = db.prepare(
    'INSERT INTO action_events (action_id, event, recorded_at, payload_hash) VALUES (?, ?, ?, ?)',
  );
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
      save(item, rootId) {
        insertItem.run(
          item.id,
          rootId,
          item.externalId,
          item.revision,
          item.snapshot === null ? null : JSON.stringify(item.snapshot),
        );
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
      requestCancel(id) {
        requestCancelBatch.run(id);
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
      get(id) {
        const row = getProposal.get(id) as ProposalRow | undefined;
        if (row === undefined) return null;
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
        );
      },
      appendEvent(actionId, event) {
        const payloadJson = event.payloadJson ?? '';
        const payloadHash = createHash('sha256').update(payloadJson).digest('hex');
        insertEvent.run(actionId, event.event, event.recordedAt, payloadHash);
      },
      get(actionId) {
        const row = getAction.get(actionId) as ActionRow | undefined;
        if (row === undefined) return null;
        const eventRows = getEvents.all(actionId) as EventRow[];
        // The journal stores the event name, timestamp and payload hash
        // (LLD §4); payload content is not duplicated into the journal.
        const events: ActionEvent[] = eventRows.map((eventRow) => ({
          event: eventRow.event as ActionEventKind,
          recordedAt: eventRow.recorded_at,
        }));
        return {
          id: row.id,
          proposalId: row.proposal_id,
          proposalVersion: row.version,
          mode: row.mode as 'apply' | 'undo',
          approvalId: row.approval_id,
          state: row.state,
          receiptJson: row.receipt_json,
          events,
        };
      },
      find(proposalId, proposalVersion, mode) {
        const row = findAction.get(proposalId, proposalVersion, mode) as ActionRow | undefined;
        if (row === undefined) return null;
        const eventRows = getEvents.all(row.id) as EventRow[];
        return {
          id: row.id,
          proposalId: row.proposal_id,
          proposalVersion: row.version,
          mode: row.mode as 'apply' | 'undo',
          approvalId: row.approval_id,
          state: row.state,
          receiptJson: row.receipt_json,
          events: eventRows.map((eventRow) => ({
            event: eventRow.event as ActionEventKind,
            recordedAt: eventRow.recorded_at,
          })),
        };
      },
      listByApproval(approvalId) {
        const rows = listActionsByApproval.all(approvalId) as ActionRow[];
        return rows.map((row) => ({
          id: row.id,
          proposalId: row.proposal_id,
          proposalVersion: row.version,
          mode: row.mode as 'apply' | 'undo',
          approvalId: row.approval_id,
          state: row.state,
          receiptJson: row.receipt_json,
          events: [],
        }));
      },
      update(actionId, update) {
        updateAction.run(update.state, update.receiptJson ?? null, actionId);
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
    close() {
      db.close();
    },
  };
}
