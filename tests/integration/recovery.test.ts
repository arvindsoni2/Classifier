import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RootConfig, Snapshot } from '../../src/domain/contracts.js';
import { createRepositories } from '../../src/adapters/persistence/repositories.js';
import { sha256Hex } from '../helpers/workflow-world.js';
import {
  reconcileAction,
  type LocationObservations,
} from '../../src/application/recovery.js';

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

const expectedSnapshot: Snapshot = {
  device: '65026',
  inode: '900001',
  size: '11',
  mtimeNs: '1760000000000000000',
  ctimeNs: '1760000000000000000',
  sha256: sha256Hex('hello there\n'),
};

function observation(content: string | null): LocationObservations['source'] {
  if (content === null) return { exists: false, snapshot: null };
  return {
    exists: true,
    snapshot: { ...expectedSnapshot, sha256: sha256Hex(content) },
  };
}

function record(overrides: Partial<Parameters<typeof reconcileAction>[0]> = {}) {
  return {
    actionId: 'action-1',
    proposalId: 'proposal-1',
    proposalVersion: 1,
    mode: 'apply' as const,
    approvalId: 'approval-1',
    state: 'intent',
    expected: expectedSnapshot,
    sourceBasename: 'invoice-01.txt',
    targetSegments: ['Documents'],
    approvalValid: true,
    ...overrides,
  };
}

describe('reconcileAction — interrupted work without duplicate moves', () => {
  it('retries only when the expected file sits at the source and the approval is valid', () => {
    const outcome = reconcileAction(record(), {
      source: observation('hello there\n'),
      target: observation(null),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.kind).toBe('retry');
      expect(outcome.value.reason).toMatch(/never took effect|source/i);
    }
  });

  it('returns a source-only action with an expired approval to review (STALE)', () => {
    const outcome = reconcileAction(record({ approvalValid: false }), {
      source: observation('hello there\n'),
      target: observation(null),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.kind).toBe('stale');
  });

  it('records Applied when the expected file sits at the target only (receipt lost)', () => {
    const outcome = reconcileAction(record(), {
      source: observation(null),
      target: observation('hello there\n'),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.kind).toBe('applied');
      if (outcome.value.kind === 'applied') {
        expect(outcome.value.after.sha256).toBe(expectedSnapshot.sha256);
      }
    }
  });

  it('conflicts on both, neither, or identity/hash mismatch', () => {
    const both = reconcileAction(record(), {
      source: observation('hello there\n'),
      target: observation('hello there\n'),
    });
    expect(both.ok).toBe(true);
    if (both.ok) expect(both.value.kind).toBe('conflict');

    const neither = reconcileAction(record(), {
      source: observation(null),
      target: observation(null),
    });
    expect(neither.ok).toBe(true);
    if (neither.ok) expect(neither.value.kind).toBe('conflict');

    const tampered = reconcileAction(record(), {
      source: observation(null),
      target: observation('DIFFERENT CONTENT!!'),
    });
    expect(tampered.ok).toBe(true);
    if (tampered.ok) expect(tampered.value.kind).toBe('conflict');
  });
});

describe('resumeBatch and undo on synthetic roots', () => {
  it('resumes a lost receipt without re-running the move, and rejects expired approvals', async () => {
    const { ApplicationService } = await import('../../src/application/workflow.js');
    const dir = mkdtempSync(join(tmpdir(), 'recovery-'));
    fixtures.push(dir);
    const rootDir = join(dir, 'Downloads');
    mkdirSync(join(rootDir, 'Documents'), { recursive: true });
    const repositories = createRepositories(join(dir, 'organiser.sqlite'));
    repositories.roots.insert({ id: 'root-1', canonicalPath: rootDir, device: '65026', inode: '900001', policyRevision: 1 });
    const batch = repositories.batches.create('root-1');
    writeFileSync(join(rootDir, 'invoice.txt'), 'round trip\n', 'utf8');
    const { statSync } = await import('node:fs');
    const st = statSync(join(rootDir, 'invoice.txt'), { bigint: true });
    const snapshot: Snapshot = {
      device: st.dev.toString(),
      inode: st.ino.toString(),
      size: st.size.toString(),
      mtimeNs: st.mtimeNs.toString(),
      ctimeNs: st.ctimeNs.toString(),
      sha256: sha256Hex('round trip\n'),
    };
    repositories.items.save(
      {
        id: 'item-1',
        sourceId: 'root-1',
        sourceKind: 'filesystem',
        externalId: 'invoice.txt',
        displayName: 'invoice.txt',
        revision: '1',
        snapshot,
        evidenceId: 'evidence-1',
      },
      'root-1',
    );
    repositories.proposals.save({
      id: 'proposal-1',
      version: 1,
      itemId: 'item-1',
      categoryId: 'cat-invoices',
      destinationId: 'dest-invoices',
      basename: 'invoice.txt',
      expected: snapshot,
      taxonomyRevision: 1,
      policyRevision: 1,
      decisionIds: [],
      state: 'pending',
    });

    const destinations = new Map([
      ['dest-invoices', { id: 'dest-invoices', segments: ['Documents'], device: st.dev.toString(), inode: '900001', status: 'observed' as const }],
    ]);
    let now = new Date('2026-10-07T10:00:00.000Z');
    const helper = {
      calls: [] as string[],
      async moveAt(action: { actionId: string; sourceBasename: string }, _root: unknown, destination: { segments: string[] }) {
        this.calls.push('move');
        const source = join(rootDir, action.sourceBasename);
        const target = join(rootDir, ...destination.segments, action.sourceBasename);
        if (existsSync(target)) {
          return { ok: false as const, code: 'COLLISION' as const, detail: 'occupied' };
        }
        if (!existsSync(source)) {
          return { ok: false as const, code: 'OUT_OF_SCOPE' as const, detail: 'source already gone' };
        }
        const content = readFileSync(source);
        const contentHash = sha256Hex(content);
        renameSync(source, target);
        const after = {
          device: st.dev.toString(),
          inode: st.ino.toString(),
          size: String(content.length),
          mtimeNs: st.mtimeNs.toString(),
          ctimeNs: st.ctimeNs.toString(),
          sha256: contentHash,
        };
        return {
          ok: true as const,
          value: {
            kind: 'move_file' as const,
            actionId: action.actionId,
            requestId: 'req-test',
            outcome: 'moved' as const,
            before: after,
            after,
            createdDirectoryIds: [],
            verified: true,
          },
        };
      },
      async undoAt() {
        this.calls.push('undo');
        return { ok: false as const, code: 'OUT_OF_SCOPE' as const, detail: 'not implemented here' };
      },
      async inspectAt(_root: unknown, segments: readonly string[]) {
        const path = join(rootDir, ...segments);
        if (!existsSync(path)) return { ok: false as const, code: 'OUT_OF_SCOPE' as const, detail: 'absent' };
        const observed = statSync(path, { bigint: true });
        return {
          ok: true as const,
          value: {
            device: observed.dev.toString(),
            inode: observed.ino.toString(),
            size: observed.size.toString(),
            mtimeNs: observed.mtimeNs.toString(),
            ctimeNs: observed.ctimeNs.toString(),
            sha256: sha256Hex(readFileSync(path)),
          },
        };
      },
      async probe() {
        return { ok: true as const, value: { kernel: 'test', openat2: true, renameat2Noreplace: true, rootVerified: true } };
      },
      async mkdirAt() {
        this.calls.push('mkdir');
        return { ok: true as const, value: { id: 'dest-1', segments: ['Documents'], device: '65026', inode: '900001', status: 'observed' as const } };
      },
    };

    const service = new ApplicationService({ repositories, helper, clock: () => now, destinations });
    const approval = service.createApproval(
      batch.id,
      [{ proposalId: 'proposal-1', version: 1 }],
      'apply',
      now,
    );
    if (!approval.ok) throw new Error(approval.detail);

    // A crash leaves the file moved but the Applied receipt unwritten.
    const { renameSync } = await import('node:fs');
    repositories.actions.save({
      id: 'action-1',
      proposalId: 'proposal-1',
      proposalVersion: 1,
      mode: 'apply',
      approvalId: approval.value.id,
      state: 'intent',
    });
    repositories.actions.appendEvent('action-1', { event: 'intent', recordedAt: now.toISOString() });
    renameSync(join(rootDir, 'invoice.txt'), join(rootDir, 'Documents', 'invoice.txt'));

    const resumed = await service.resumeBatch(batch.id);
    expect(resumed.results).toHaveLength(1);
    expect(resumed.results[0]?.outcome).toBe('applied');
    expect(helper.calls).not.toContain('move');
    expect(readFileSync(join(rootDir, 'Documents', 'invoice.txt'), 'utf8')).toBe('round trip\n');

    // After expiry, a SOURCE-ONLY action must not be resumed into a retry:
    // it returns to review instead. The later approval was issued at the
    // original time; the clock is then advanced past its 24-hour expiry.
    const secondBatch = repositories.batches.create('root-1');
    writeFileSync(join(rootDir, 'later.txt'), 'later file\n', 'utf8');
    const laterSt = statSync(join(rootDir, 'later.txt'), { bigint: true });
    repositories.items.save(
      {
        id: 'item-later',
        sourceId: 'root-1',
        sourceKind: 'filesystem',
        externalId: 'later.txt',
        displayName: 'later.txt',
        revision: '1',
        snapshot: null,
        evidenceId: 'evidence-later',
      },
      'root-1',
    );
    repositories.proposals.save({
      id: 'proposal-later',
      version: 1,
      itemId: 'item-later',
      categoryId: 'cat-invoices',
      destinationId: 'dest-invoices',
      basename: 'later.txt',
      expected: {
        device: laterSt.dev.toString(),
        inode: laterSt.ino.toString(),
        size: laterSt.size.toString(),
        mtimeNs: laterSt.mtimeNs.toString(),
        ctimeNs: laterSt.ctimeNs.toString(),
        sha256: sha256Hex('later file\n'),
      },
      taxonomyRevision: 1,
      policyRevision: 1,
      decisionIds: [],
      state: 'pending',
    });
    const laterApproval = service.createApproval(
      secondBatch.id,
      [{ proposalId: 'proposal-later', version: 1 }],
      'apply',
      now,
    );
    if (!laterApproval.ok) throw new Error(laterApproval.detail);
    repositories.actions.save({
      id: 'action-later',
      proposalId: 'proposal-later',
      proposalVersion: 1,
      mode: 'apply',
      approvalId: laterApproval.value.id,
      state: 'intent',
    });
    // Expired, but the file is still only at the source: the move never ran.
    now = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    const expired = await service.resumeBatch(secondBatch.id);
    expect(expired.results).toHaveLength(1);
    expect(expired.results[0]?.outcome).toBe('stale');
    expect(helper.calls).not.toContain('move');
    expect(readFileSync(join(rootDir, 'later.txt'), 'utf8')).toBe('later file\n');
  });

  it('undoes a verified move and refuses an occupied original location', async () => {
    const { ApplicationService } = await import('../../src/application/workflow.js');
    const dir = mkdtempSync(join(tmpdir(), 'undo-'));
    fixtures.push(dir);
    const rootDir = join(dir, 'Downloads');
    mkdirSync(join(rootDir, 'Documents'), { recursive: true });
    const repositories = createRepositories(join(dir, 'organiser.sqlite'));
    repositories.roots.insert({ id: 'root-1', canonicalPath: rootDir, device: '65026', inode: '900001', policyRevision: 1 });
    const batch = repositories.batches.create('root-1');
    writeFileSync(join(rootDir, 'a.txt'), 'AAA\n', 'utf8');
    writeFileSync(join(rootDir, 'b.txt'), 'BBB\n', 'utf8');
    const { statSync, renameSync } = await import('node:fs');
    const snapshotOfPath = (path: string): Snapshot => {
      const st = statSync(path, { bigint: true });
      return {
        device: st.dev.toString(),
        inode: st.ino.toString(),
        size: st.size.toString(),
        mtimeNs: st.mtimeNs.toString(),
        ctimeNs: st.ctimeNs.toString(),
        sha256: sha256Hex(readFileSync(path)),
      };
    };
    for (const basename of ['a.txt', 'b.txt']) {
      repositories.items.save(
        {
          id: `item-${basename}`,
          sourceId: 'root-1',
          sourceKind: 'filesystem',
          externalId: basename,
          displayName: basename,
          revision: '1',
          snapshot: snapshotOfPath(join(rootDir, basename)),
          evidenceId: 'evidence-1',
        },
        'root-1',
      );
      repositories.proposals.save({
        id: `proposal-${basename}`,
        version: 1,
        itemId: `item-${basename}`,
        categoryId: 'cat-invoices',
        destinationId: 'dest-invoices',
        basename,
        expected: snapshotOfPath(join(rootDir, basename)),
        taxonomyRevision: 1,
        policyRevision: 1,
        decisionIds: [],
        state: 'pending',
      });
    }
    const destinations = new Map([
      ['dest-invoices', { id: 'dest-invoices', segments: ['Documents'], device: '65026', inode: '900001', status: 'observed' as const }],
    ]);
    const now = new Date('2026-10-07T10:00:00.000Z');
    const helper = {
      calls: [] as string[],
      async moveAt(action: { actionId: string; sourceBasename: string }, rootArg: RootConfig, destination: { segments: string[] }) {
        this.calls.push(`move:${action.sourceBasename}`);
        const source = join(rootArg.absolutePath, action.sourceBasename);
        const target = join(rootArg.absolutePath, ...destination.segments, action.sourceBasename);
        if (existsSync(target)) return { ok: false as const, code: 'COLLISION' as const, detail: 'occupied' };
        if (!existsSync(source)) return { ok: false as const, code: 'OUT_OF_SCOPE' as const, detail: 'absent' };
        renameSync(source, target);
        return {
          ok: true as const,
          value: {
            kind: 'move_file' as const,
            actionId: action.actionId,
            requestId: 'r',
            outcome: 'moved' as const,
            before: snapshotOfPath(target),
            after: snapshotOfPath(target),
            createdDirectoryIds: [],
            verified: true,
          },
        };
      },
      async undoAt(action: { actionId: string; basename: string; targetSegments: string[] }, rootArg: RootConfig) {
        this.calls.push(`undo:${action.basename}`);
        const target = join(rootArg.absolutePath, ...action.targetSegments, action.basename);
        const original = join(rootArg.absolutePath, action.basename);
        if (existsSync(original)) return { ok: false as const, code: 'COLLISION' as const, detail: 'occupied' };
        if (!existsSync(target)) return { ok: false as const, code: 'OUT_OF_SCOPE' as const, detail: 'absent' };
        renameSync(target, original);
        return {
          ok: true as const,
          value: {
            kind: 'move_file' as const,
            actionId: action.actionId,
            requestId: 'r',
            outcome: 'moved' as const,
            before: snapshotOfPath(original),
            after: snapshotOfPath(original),
            createdDirectoryIds: [],
            verified: true,
          },
        };
      },
      async inspectAt(rootArg: RootConfig, segments: readonly string[]) {
        const path = join(rootArg.absolutePath, ...segments);
        if (!existsSync(path)) return { ok: false as const, code: 'OUT_OF_SCOPE' as const, detail: 'absent' };
        return { ok: true as const, value: snapshotOfPath(path) };
      },
      async probe() {
        return { ok: true as const, value: { kernel: 'test', openat2: true, renameat2Noreplace: true, rootVerified: true } };
      },
      async mkdirAt() {
        return { ok: true as const, value: { id: 'dest-1', segments: ['Documents'], device: '65026', inode: '900001', status: 'observed' as const } };
      },
    };
    const service = new ApplicationService({ repositories, helper, clock: () => now, destinations });

    const applyApproval = service.createApproval(
      batch.id,
      [
        { proposalId: 'proposal-a.txt', version: 1 },
        { proposalId: 'proposal-b.txt', version: 1 },
      ],
      'apply',
      now,
    );
    if (!applyApproval.ok) throw new Error(applyApproval.detail);
    const applied = await service.applyBatch(batch.id, applyApproval.value.id, applyApproval.value.actionSetHash);
    expect(applied.results.every((action) => action.outcome === 'applied')).toBe(true);

    // The now-applied action can be undone with a separately approved undo.
    const undoApproval = service.createApproval(
      batch.id,
      [{ proposalId: 'proposal-a.txt', version: 1 }],
      'undo',
      now,
    );
    if (!undoApproval.ok) throw new Error(undoApproval.detail);
    const actionId = repositories.actions.find('proposal-a.txt', 1, 'apply')!.id;
    const undone = await service.undoAction(actionId, undoApproval.value.id);
    expect(undone.ok).toBe(true);
    expect(readFileSync(join(rootDir, 'a.txt'), 'utf8')).toBe('AAA\n');
    expect(existsSync(join(rootDir, 'Documents', 'a.txt'))).toBe(false);

    // An occupied original location is a conflict, never an overwrite.
    const secondUndo = service.createApproval(batch.id, [{ proposalId: 'proposal-b.txt', version: 1 }], 'undo', now);
    if (!secondUndo.ok) throw new Error(secondUndo.detail);
    const bActionId = repositories.actions.find('proposal-b.txt', 1, 'apply')!.id;
    writeFileSync(join(rootDir, 'b.txt'), 'NEW OCCUPANT\n', 'utf8');
    const blocked = await service.undoAction(bActionId, secondUndo.value.id);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe('COLLISION');
    expect(readFileSync(join(rootDir, 'b.txt'), 'utf8')).toBe('NEW OCCUPANT\n');
    expect(readFileSync(join(rootDir, 'Documents', 'b.txt'), 'utf8')).toBe('BBB\n');
  });
});
