import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FaultPoint } from '../../src/application/workflow.js';
import { CrashSignal, assertExactlyOnce, makeWorld } from '../helpers/workflow-world.js';

describe('applyBatch — happy paths and idempotency', () => {
  it('applies approved actions with journalled receipts', async () => {
    const world = makeWorld('happy');
    const approval = world.approve();
    const result = await world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash);
    expect(result.results).toHaveLength(2);
    for (const action of result.results) {
      expect(action.outcome).toBe('applied');
      expect(action.receipt?.verified).toBe(true);
    }
    assertExactlyOnce(world, 'invoice-01.txt', 'first invoice\n');
    assertExactlyOnce(world, 'invoice-02.txt', 'second invoice\n');
    expect(world.helper.calls.filter((call) => call.verb === 'move')).toHaveLength(2);
    const record = world.repositories.actions.get(result.results[0]!.actionId);
    expect(record?.state).toBe('applied');
    expect(record?.events.map((event) => event.event)).toEqual(
      expect.arrayContaining(['planned', 'intent', 'applied']),
    );
  });

  it('returns the existing receipt on a repeated apply without re-running the move', async () => {
    const world = makeWorld('idempotent');
    const approval = world.approve();
    const first = await world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash);
    const second = await world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash);
    expect(second.results).toHaveLength(2);
    expect(second.results.map((action) => action.outcome)).toEqual(['applied', 'applied']);
    expect(world.helper.calls.filter((call) => call.verb === 'move')).toHaveLength(2);
    expect(second.results[0]?.receipt?.actionId).toBe(first.results[0]?.receipt?.actionId);
  });

  it('refuses an approval whose action-set hash does not match the bound actions', async () => {
    const world = makeWorld('hash-mismatch');
    const approval = world.approve();
    const result = await world.service.applyBatch(world.batch.id, approval.approvalId, 'a'.repeat(64));
    expect(result.results.every((action) => action.outcome === 'stale')).toBe(true);
    expect(world.exists('invoice-01.txt')).toBe(true);
    expect(world.helper.calls).toHaveLength(0);
  });

  it('records a collision without touching the target or the source', async () => {
    const world = makeWorld('collision');
    writeFileSync(join(world.rootDir, 'Documents', 'invoice-01.txt'), 'precious target\n', 'utf8');
    const approval = world.approve();
    const result = await world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash);
    const first = result.results.find((action) => action.proposalId === 'proposal-invoice-01.txt');
    expect(first?.outcome).toBe('conflict');
    expect(world.read('Documents/invoice-01.txt')).toBe('precious target\n');
    expect(world.read('invoice-01.txt')).toBe('first invoice\n');
  });

  it('stops between actions when cancellation is requested', async () => {
    const world = makeWorld('cancel');
    world.repositories.batches.requestCancel(world.batch.id);
    const approval = world.approve();
    const result = await world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash);
    expect(result.results.some((action) => action.outcome === 'canceled')).toBe(true);
    expect(world.helper.calls.filter((call) => call.verb === 'move').length).toBeLessThan(2);
  });
});

describe('applyBatch — crash at every effect boundary recovers without duplicate moves', () => {
  const points: FaultPoint[] = ['before-intent', 'after-intent', 'after-rename', 'after-verify', 'before-applied-commit'];

  for (const point of points) {
    it(`recovers from a crash at ${point}`, async () => {
      const world = makeWorld(`crash-${point}`, { 'invoice-01.txt': 'only file\n' });
      const approval = world.approve();
      world.crashAt(point);
      await expect(
        world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash),
      ).rejects.toThrow(CrashSignal);

      // A restarted process reconciles from the journal only.
      const restarted = world.restart();
      const resumed = await restarted.resumeBatch(world.batch.id);
      expect(resumed.results).toHaveLength(1);
      const outcome = resumed.results[0]!.outcome;
      expect(['applied', 'conflict']).toContain(outcome);

      // Whatever the boundary, the file survived exactly once with its bytes.
      assertExactlyOnce(world, 'invoice-01.txt', 'only file\n');

      // No duplicate move after recovery: at most one move call per attempt,
      // and a crash before the rename cannot leave the file moved twice.
      const moveCalls = world.helper.calls.filter((call) => call.verb === 'move').length;
      expect(moveCalls).toBeLessThanOrEqual(2);
      if (point === 'after-rename' || point === 'after-verify' || point === 'before-applied-commit') {
        // The rename already happened: recovery must NOT re-run the syscall.
        expect(moveCalls).toBe(1);
        expect(world.exists('Documents/invoice-01.txt')).toBe(true);
      }
      if (point === 'before-intent' || point === 'after-intent') {
        expect(moveCalls).toBeLessThanOrEqual(2);
      }
    });
  }

  it('a proposed folder stays logical until accepted (no filesystem effect)', async () => {
    // Spec review R10: proposing a folder persists a logical candidate; the
    // physical directory is created by approved execution, never by the
    // proposal itself.
    const world = makeWorld('mkdir');
    const proposed = await world.service.proposeFolder(['Documents'], 'New Folder', world.batch.id, 'New Folder');
    expect(proposed.ok).toBe(true);
    // No filesystem effect from the proposal.
    expect(world.exists('Documents/New Folder')).toBe(false);
    // The candidate is persisted as a draft bound to the real parent identity.
    const candidates = world.repositories.folderCandidates.listByBatch(world.batch.id);
    expect(candidates.some((candidate) => candidate.label === 'New Folder')).toBe(true);
    expect(candidates.find((candidate) => candidate.label === 'New Folder')?.reviewState).toBe('draft');
    expect(candidates.find((candidate) => candidate.label === 'New Folder')?.destinationParentId).toBe('dest-invoices');
    // No proposal targets it until it is accepted and materialised.
    if (proposed.ok) {
      expect(world.proposals.some((proposal) => proposal.destinationId === proposed.value.candidateId)).toBe(false);
    }
  });

  it('refuses to propose a folder under an unknown parent', async () => {
    const world = makeWorld('mkdir-unknown-parent');
    const proposed = await world.service.proposeFolder(['Not', 'In', 'Catalogue'], 'New Folder', world.batch.id, 'New Folder');
    expect(proposed.ok).toBe(false);
    if (!proposed.ok) expect(proposed.code).toBe('OUT_OF_SCOPE');
    expect(world.repositories.folderCandidates.listByBatch(world.batch.id)).toHaveLength(0);
  });
});
