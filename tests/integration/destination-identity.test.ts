import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeWorld, type World } from '../helpers/workflow-world.js';

/**
 * Spec review R2: apply must move to the destination identity that was
 * approved. Re-discovery refreshing the catalogue must never rewrite an
 * outstanding approval's expectations — a replaced directory is a conflict.
 */
describe('destination identity pins (R2)', () => {
  it('conflicts when the approved destination directory was replaced', async () => {
    const world: World = makeWorld('destination-swap');
    const approval = world.approve();

    // The user renames Documents away and a different directory takes its name.
    renameSync(join(world.rootDir, 'Documents'), join(world.rootDir, 'Documents-old'));
    mkdirSync(join(world.rootDir, 'Documents'), { recursive: true });
    writeFileSync(join(world.rootDir, 'Documents', 'unrelated.txt'), 'new folder content\n', 'utf8');
    // Re-discovery observes the replacement identity.
    world.swapDestinationIdentity('dest-invoices', '65026', '999999');

    const result = await world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash);

    expect(result.results.every((action) => action.outcome === 'conflict')).toBe(true);
    expect(result.results[0]?.detail).toMatch(/identity|destination/i);
    // The helper is never called with the replacement identity as the pin.
    expect(world.helper.calls).toHaveLength(0);
    expect(world.exists('invoice-01.txt')).toBe(true);
    expect(world.read('Documents/unrelated.txt')).toBe('new folder content\n');
  });

  it('conflicts when the approved root identity changed', async () => {
    const world: World = makeWorld('root-swap');
    const approval = world.approve();

    // A different filesystem is mounted at the same path: the root record now
    // holds different identity than when the batch was approved.
    world.repositories.roots.insert({
      id: 'root-1',
      canonicalPath: world.rootDir,
      device: '777777',
      inode: '888888',
      policyRevision: 1,
    });

    const result = await world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash);

    expect(result.results.every((action) => action.outcome === 'conflict')).toBe(true);
    expect(result.results[0]?.detail).toMatch(/root|identity/i);
    expect(world.helper.calls).toHaveLength(0);
    expect(world.exists('invoice-01.txt')).toBe(true);
  });

  it('applies when the destination identity still matches the pin', async () => {
    const world: World = makeWorld('destination-stable');
    const approval = world.approve();
    const result = await world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash);
    expect(result.results.every((action) => action.outcome === 'applied')).toBe(true);
    expect(world.exists('Documents/invoice-01.txt')).toBe(true);
  });
});
