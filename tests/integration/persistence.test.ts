import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import type { Item, Proposal } from '../../src/domain/contracts.js';
import { createRepositories } from '../../src/adapters/persistence/repositories.js';

// Synthetic fixture storage only (AGENTS.md rule 12): never the real
// Downloads directory or a real organisation root.
const tmpDir = mkdtempSync(join('/tmp/opencode', 'persistence-'));
const dbPath = join(tmpDir, 'organiser.sqlite');
const repos = createRepositories(dbPath);

afterAll(() => {
  repos.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const hex64 = 'b'.repeat(64);
// Deliberately above Number.MAX_SAFE_INTEGER to prove decimal-string survival.
const hugeInode = '9999999999999999999999999999999456';

const root = {
  id: 'root-1',
  canonicalPath: '/tmp/opencode/fixture-downloads',
  device: '65026',
  inode: '998877665544332211',
  policyRevision: 1,
};

const item: Item = {
  id: 'item-1',
  sourceId: root.id,
  sourceKind: 'filesystem',
  externalId: 'report-2026-q3.pdf',
  displayName: 'report-2026-q3.pdf',
  revision: '1',
  snapshot: {
    device: root.device,
    inode: hugeInode,
    size: '1048576',
    mtimeNs: '1760000000123456789',
    ctimeNs: '1760000000123456789',
    sha256: hex64,
  },
  evidenceId: 'evidence-1',
};

const proposal: Proposal = {
  id: 'proposal-1',
  version: 1,
  itemId: item.id,
  categoryId: 'cat-docs',
  destinationId: 'dest-docs',
  basename: 'report-2026-q3.pdf',
  expected: item.snapshot!,
  taxonomyRevision: 1,
  policyRevision: 1,
  decisionIds: ['decision-1'],
  state: 'pending',
};

describe('createRepositories', () => {
  it('creates owner-only storage with WAL journaling', () => {
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    const probe = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      expect(probe.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      probe.close();
    }
  });

  it('batches.create returns a batch bound to the root', () => {
    repos.roots.insert(root);
    const batch = repos.batches.create(root.id);
    expect(batch.id).toBeTruthy();
    expect(batch.rootId).toBe(root.id);
    expect(repos.batches.get(batch.id)?.id).toBe(batch.id);
  });

  it('requests and lists cancellation state', () => {
    const batch = repos.batches.create(root.id);
    expect(repos.batches.get(batch.id)?.cancellationRequested).toBe(false);
    repos.batches.requestCancel(batch.id);
    expect(repos.batches.get(batch.id)?.cancellationRequested).toBe(true);
    expect(repos.batches.listByRoot(root.id).map((entry) => entry.id)).toContain(batch.id);
  });

  it('rejects proposals for unknown items (foreign keys enforced)', () => {
    expect(() =>
      repos.proposals.save({ ...proposal, id: 'proposal-orphan', itemId: 'item-missing' }),
    ).toThrow();
  });

  it('persists_unique_action_and_rolls_back_event_on_failure', () => {
    repos.roots.insert(root);
    const batch = repos.batches.create(root.id);
    repos.items.save(item, root.id);

    repos.proposals.save(proposal);
    const loaded = repos.proposals.get(proposal.id);
    expect(loaded?.expected.inode).toBe(hugeInode);
    expect(loaded?.expected.mtimeNs).toBe('1760000000123456789');
    expect(loaded?.expected.sha256).toBe(hex64);
    expect(loaded?.state).toBe('pending');

    repos.approvals.insert({
      id: 'approval-1',
      batchId: batch.id,
      actionSetHash: 'c'.repeat(64),
      taxonomyRevision: 1,
      policyRevision: 1,
      selectedActionsJson: JSON.stringify([{ proposalId: proposal.id, version: 1 }]),
      expiresAt: '2026-10-08T00:00:00.000Z',
      mode: 'apply',
      // A row created before identity pins existed reads back pin-less; the
      // application then requires re-approval rather than bypassing pins.
      pinsJson: null,
    });

    repos.actions.save({
      id: 'action-1',
      proposalId: proposal.id,
      proposalVersion: 1,
      mode: 'apply',
      approvalId: 'approval-1',
      state: 'planned',
    });

    // UNIQUE(proposal, version, mode): a second action for the same
    // proposal version and mode must fail.
    expect(() =>
      repos.actions.save({
        id: 'action-1-duplicate',
        proposalId: proposal.id,
        proposalVersion: 1,
        mode: 'apply',
        approvalId: 'approval-1',
        state: 'planned',
      }),
    ).toThrow();

    // A failure inside the transaction after an event append must roll the
    // event back: zero new events survive.
    expect(() =>
      repos.transaction(() => {
        repos.actions.appendEvent('action-1', {
          event: 'intent',
          recordedAt: '2026-10-07T12:00:00.000Z',
          payloadJson: JSON.stringify({ source: 'test' }),
        });
        throw new Error('injected failure inside transaction');
      }),
    ).toThrow('injected failure inside transaction');

    expect(repos.actions.get('action-1')?.events).toHaveLength(0);

    // Outside a transaction, events persist and are returned with the record.
    repos.actions.appendEvent('action-1', {
      event: 'intent',
      recordedAt: '2026-10-07T12:00:01.000Z',
      payloadJson: JSON.stringify({ source: 'test' }),
    });
    const record = repos.actions.get('action-1');
    expect(record?.events).toHaveLength(1);
    expect(record?.events[0]?.event).toBe('intent');
    expect(record?.receiptJson).toBeNull();
  });
});
