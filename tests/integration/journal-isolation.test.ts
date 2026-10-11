import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MoveReceipt, Result } from '../../src/domain/contracts.js';
import { createRepositories } from '../../src/adapters/persistence/repositories.js';
import { ApplicationService } from '../../src/application/workflow.js';
import { CrashSignal, makeWorld, type World } from '../helpers/workflow-world.js';

/**
 * Spec review R6: the journal must carry the immutable action data and real
 * payloads, recovery must read that data instead of the mutable current
 * proposal/catalogue, and writers on one root must serialise across service
 * instances (and therefore across processes).
 */
describe('journal and writer isolation (R6)', () => {
  it('journals the immutable source/target mapping and expected snapshot', async () => {
    const world: World = makeWorld('journal-immutable', { 'invoice-01.txt': 'only file\n' });
    const approval = world.approve();
    world.crashAt('after-intent');
    await expect(
      world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash),
    ).rejects.toThrow(CrashSignal);

    const record = world.repositories.actions.find('proposal-invoice-01.txt', 1, 'apply');
    expect(record).not.toBeNull();
    expect(record?.sourceBasename).toBe('invoice-01.txt');
    expect(record?.targetSegments).toEqual(['Documents']);
    expect(record?.expectedSnapshot?.sha256).toBe(world.proposals[0]?.expected.sha256);
    expect(record?.destinationPin).toMatchObject({ destinationId: 'dest-invoices' });
  });

  it('retains the journalled payload for intent events', async () => {
    const world: World = makeWorld('journal-payload', { 'invoice-01.txt': 'only file\n' });
    const approval = world.approve();
    await world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash);

    const record = world.repositories.actions.find('proposal-invoice-01.txt', 1, 'apply');
    const events = record === null ? [] : world.repositories.actions.events(record.id);
    const intent = events.find((event) => event.event === 'intent');
    expect(intent).toBeDefined();
    expect(intent?.payloadJson).toBeTruthy();
    expect(intent?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(intent?.payloadJson ?? '{}')).toMatchObject({
      destinationSegments: ['Documents'],
      sourceBasename: 'invoice-01.txt',
      expected: { sha256: world.proposals[0]?.expected.sha256 },
    });
  });

  it('recovers from the journal when the proposal record has since changed', async () => {
    const world: World = makeWorld('journal-recovery', { 'invoice-01.txt': 'only file\n' });
    const approval = world.approve();
    world.crashAt('after-rename');
    await expect(
      world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash),
    ).rejects.toThrow(CrashSignal);

    // The proposal row is mutated after the crash (e.g. a re-classification).
    const stored = world.repositories.proposals.get('proposal-invoice-01.txt');
    expect(stored).not.toBeNull();
    if (stored !== null) {
      world.repositories.proposals.save({
        ...stored,
        expected: { ...stored.expected, sha256: 'f'.repeat(64) },
      });
    }

    // Recovery must use the journal's own snapshot, observe the moved file and
    // record Applied — not trust the edited proposal row.
    const restarted = world.restart();
    const resumed = await restarted.resumeBatch(world.batch.id);
    expect(resumed.results[0]?.outcome).toBe('applied');
    expect(world.exists('Documents/invoice-01.txt')).toBe(true);
  });

  it('conflicts when the approved destination was replaced before recovery', async () => {
    const world: World = makeWorld('journal-destination-edit', { 'invoice-01.txt': 'only file\n' });
    const approval = world.approve();
    world.crashAt('after-intent');
    await expect(
      world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash),
    ).rejects.toThrow(CrashSignal);

    // The user renames the destination and a different folder takes its name;
    // re-discovery observes the replacement identity.
    renameSync(join(world.rootDir, 'Documents'), join(world.rootDir, 'Documents-old'));
    mkdirSync(join(world.rootDir, 'Documents'), { recursive: true });
    world.swapDestinationIdentity('dest-invoices', '65026', '999999');

    const restarted = world.restart();
    const resumed = await restarted.resumeBatch(world.batch.id);
    expect(resumed.results[0]?.outcome).toBe('conflict');
    expect(world.exists('invoice-01.txt')).toBe(true);
    expect(world.exists('Documents/invoice-01.txt')).toBe(false);
  });

  it('serialises two writers on the same root', async () => {
    const world: World = makeWorld('writer-lock', { 'invoice-01.txt': 'only file\n' });
    const approval = world.approve();

    // A second application instance on the same database (another process
    // would open its own connection): it must not interleave with the first.
    const second = new ApplicationService({
      repositories: createRepositories(join(world.dir, 'organiser.sqlite')),
      helper: world.helper,
      clock: () => new Date('2026-10-07T10:00:00.000Z'),
      destinations: world.destinations,
    });

    let releaseMove = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseMove = resolve;
    });
    const realMoveAt = world.helper.moveAt.bind(world.helper);
    world.helper.moveAt = async (action, root, destination): Promise<Result<MoveReceipt>> => {
      await gate;
      return realMoveAt(action, root, destination);
    };

    const first = world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash);
    // The second writer must be told the root is locked, not run concurrently.
    const secondResult = await second.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash);
    expect(secondResult.results.every((entry) => entry.outcome === 'stale')).toBe(true);

    releaseMove();
    await first;
    expect(world.exists('Documents/invoice-01.txt')).toBe(true);
  });
});
