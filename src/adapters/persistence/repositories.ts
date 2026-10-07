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
  actionSetHash: string;
  taxonomyRevision: Revision;
  policyRevision: Revision;
  selectedActionsJson: string;
  expiresAt: string;
  mode: 'apply' | 'undo';
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
  roots: { insert(root: RootRecord): void };
  items: { save(item: Item, rootId: Id): void };
  batches: { create(rootId: Id): Batch; get(id: Id): Batch | null };
  proposals: { save(proposal: Proposal): void; get(id: Id): Proposal | null };
  approvals: { insert(approval: ApprovalRecord): void };
  actions: {
    save(input: ActionSaveInput): void;
    appendEvent(actionId: Id, event: ActionEvent): void;
    get(actionId: Id): ActionRecord | null;
  };
  transaction<T>(fn: () => T): T;
  close(): void;
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

  // Owner-only storage file. WAL/SHM sidecar files are transient and
  // umask-controlled; the durable database file itself is never
  // group/world-accessible.
  chmodSync(dbPath, 0o600);

  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

  const insertRoot = db.prepare(
    'INSERT INTO roots (id, canonical_path, device, inode, policy_revision) VALUES (?, ?, ?, ?, ?)',
  );
  const insertItem = db.prepare(
    `INSERT OR REPLACE INTO items (id, root_id, external_id, revision, snapshot_json)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertBatch = db.prepare(
    'INSERT INTO batches (id, root_id, stage, created_at, cancellation_requested) VALUES (?, ?, ?, ?, 0)',
  );
  const getBatch = db.prepare('SELECT * FROM batches WHERE id = ?');
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
    `INSERT INTO approvals (id, action_set_hash, taxonomy_revision, policy_revision,
       selected_actions_json, expires_at, mode)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAction = db.prepare(
    `INSERT INTO actions (id, proposal_id, version, approval_id, mode, state, receipt_json)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  );
  const getAction = db.prepare('SELECT * FROM actions WHERE id = ?');
  const getEvents = db.prepare(
    'SELECT event, recorded_at FROM action_events WHERE action_id = ? ORDER BY seq',
  );
  const insertEvent = db.prepare(
    'INSERT INTO action_events (action_id, event, recorded_at, payload_hash) VALUES (?, ?, ?, ?)',
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
          approval.actionSetHash,
          approval.taxonomyRevision,
          approval.policyRevision,
          approval.selectedActionsJson,
          approval.expiresAt,
          approval.mode,
        );
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
    },
    transaction,
    close() {
      db.close();
    },
  };
}
