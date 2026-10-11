import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MoveReceipt, Result, RootConfig, Snapshot } from '../../src/domain/contracts.js';
import { CrashSignal, makeWorld, type World } from '../helpers/workflow-world.js';

/**
 * Spec review R5: interrupted undo, ambiguous helper outcomes, unobservable
 * locations and cancellation ordering. Every scenario runs through the real
 * ApplicationService journal; the fault hook simulates process death.
 */
describe('undo and recovery boundaries (R5)', () => {
  it('resumes an undo interrupted after the reverse rename', async () => {
    const world: World = makeWorld('undo-crash', { 'invoice-01.txt': 'only file\n' });
    const approval = world.approve();
    await world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash);
    expect(world.exists('Documents/invoice-01.txt')).toBe(true);

    // A separately approved undo (mode 'undo') that dies after the rename.
    const undoApproval = world.service.createApproval(
      world.batch.id,
      [{ proposalId: 'proposal-invoice-01.txt', version: 1 }],
      'undo',
      new Date('2026-10-07T12:00:00.000Z'),
    );
    expect(undoApproval.ok).toBe(true);
    if (!undoApproval.ok) return;
    world.crashAt('after-undo-rename');
    await expect(
      world.service.undoAction('action-'.length ? firstApplyActionId(world) : '', undoApproval.value.id),
    ).rejects.toThrow(CrashSignal);

    // The reverse rename already happened; the intent record is non-terminal.
    expect(world.exists('invoice-01.txt')).toBe(true);

    // A restarted process must reconcile the undo, not skip it.
    const restarted = world.restart();
    const resumed = await restarted.resumeBatch(world.batch.id);
    const undone = resumed.results.find((entry) => entry.proposalId === 'proposal-invoice-01.txt');
    expect(undone?.outcome).toBe('undone');
    expect(world.exists('invoice-01.txt')).toBe(true);
    expect(world.exists('Documents/invoice-01.txt')).toBe(false);
    const undoCalls = world.helper.calls.filter((call) => call.verb === 'undo').length;
    expect(undoCalls).toBe(1);
  }, 30_000);

  it('treats a helper error after an uncertain effect as needing reconciliation', async () => {
    const world: World = makeWorld('undo-uncertain', { 'invoice-01.txt': 'only file\n' });
    const approval = world.approve();
    await world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash);

    // A helper that performs the reverse move and then reports failure: the
    // effect happened but the caller cannot know it.
    const realUndoAt = world.helper.undoAt.bind(world.helper);
    world.helper.undoAt = async (action, root): Promise<Result<MoveReceipt>> => {
      await realUndoAt(action, root);
      return { ok: false, code: 'PROVIDER_FAILED', detail: 'connection lost after the effect' };
    };

    const undoApproval = world.service.createApproval(
      world.batch.id,
      [{ proposalId: 'proposal-invoice-01.txt', version: 1 }],
      'undo',
      new Date('2026-10-07T12:00:00.000Z'),
    );
    expect(undoApproval.ok).toBe(true);
    if (!undoApproval.ok) return;
    const failed = await world.service.undoAction(firstApplyActionId(world), undoApproval.value.id);
    expect(failed.ok).toBe(false);

    // The record must not be terminal: a restart reconciles from reality.
    const record = world.repositories.actions.find('proposal-invoice-01.txt', 1, 'undo');
    expect(record?.state).not.toBe('undone');
    expect(['undo_intent', 'reconciling']).toContain(record?.state);
    expect(world.exists('invoice-01.txt')).toBe(true);

    const restarted = world.restart();
    const resumed = await restarted.resumeBatch(world.batch.id);
    const undone = resumed.results.find((entry) => entry.proposalId === 'proposal-invoice-01.txt');
    expect(undone?.outcome).toBe('undone');
  }, 30_000);

  it('does not mistake an unobservable location for an absent one', async () => {
    const world: World = makeWorld('unobservable', { 'invoice-01.txt': 'only file\n' });
    const approval = world.approve();
    world.crashAt('after-rename');
    await expect(
      world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash),
    ).rejects.toThrow(CrashSignal);

    // The source location cannot be inspected (permission/unsupported): the
    // observation is unobservable, which must not be read as "absent".
    world.helper.inspectAt = async (root: RootConfig, segments: readonly string[]): Promise<Result<Snapshot>> => {
      if (segments.length === 1) {
        return { ok: false, code: 'UNSUPPORTED', detail: 'cannot inspect the source location' };
      }
      return { ok: true, value: snapshotAt(join(root.absolutePath, ...segments)) };
    };

    const restarted = world.restart();
    const resumed = await restarted.resumeBatch(world.batch.id);
    const outcome = resumed.results.find((entry) => entry.proposalId === 'proposal-invoice-01.txt');
    expect(outcome?.outcome).toBe('conflict');
    expect(outcome?.detail).toMatch(/observ/i);
    // No move is attempted on the strength of an absent reading.
    const moveCalls = world.helper.calls.filter((call) => call.verb === 'move').length;
    expect(moveCalls).toBe(1);
  }, 30_000);

  it('resolves whether an effect happened before honoring cancellation', async () => {
    const world: World = makeWorld('cancel-after-effect', { 'invoice-01.txt': 'only file\n' });
    const approval = world.approve();
    world.crashAt('after-rename');
    await expect(
      world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash),
    ).rejects.toThrow(CrashSignal);
    // The rename happened; the user now asks to cancel the batch.
    world.repositories.batches.requestCancel(world.batch.id);

    const restarted = world.restart();
    const resumed = await restarted.resumeBatch(world.batch.id);
    const outcome = resumed.results.find((entry) => entry.proposalId === 'proposal-invoice-01.txt');
    // The file IS at the destination: the effect happened, so the record is
    // applied — cancellation must not erase that fact.
    expect(outcome?.outcome).toBe('applied');
    expect(world.exists('Documents/invoice-01.txt')).toBe(true);
  }, 30_000);
});

function firstApplyActionId(world: World): string {
  const record = world.repositories.actions.find('proposal-invoice-01.txt', 1, 'apply');
  if (record === null) throw new Error('expected an apply action in the journal');
  return record.id;
}

function snapshotAt(path: string): Snapshot {
  const content = readFileSync(path);
  return {
    device: '65026',
    inode: '900002',
    size: String(Buffer.byteLength(content)),
    mtimeNs: '1760000000000000000',
    ctimeNs: '1760000000000000000',
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}
