import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createRepositories } from '../../src/adapters/persistence/repositories.js';
import { ApplicationService } from '../../src/application/workflow.js';
import { makeWorld, type World } from '../helpers/workflow-world.js';

/**
 * Spec review F6: the root lease must be a HEARTBEAT lease (elapsed time
 * alone never steals a live writer's lock), undo must take it, and a dead
 * holder's lease must expire so a later writer can proceed.
 */
const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  fixtures.push(dir);
  return dir;
}

describe('root writer lease (F6)', () => {
  it('refuses undo while another owner holds the root lease', async () => {
    const world: World = makeWorld('lease-undo');
    const approval = world.approve();
    await world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash);

    const undoApproval = world.service.createApproval(
      world.batch.id,
      [{ proposalId: 'proposal-invoice-01.txt', version: 1 }],
      'undo',
      new Date('2026-10-07T12:00:00.000Z'),
    );
    expect(undoApproval.ok).toBe(true);
    if (!undoApproval.ok) return;

    // Simulate a live writer in ANOTHER process holding the lease.
    const batch = world.repositories.batches.get(world.batch.id);
    expect(batch).not.toBeNull();
    const foreignOwner = world.repositories.locks.acquire('root-1', 60_000);
    expect(foreignOwner).not.toBeNull();

    const apply = world.repositories.actions.find('proposal-invoice-01.txt', 1, 'apply');
    const undone = await world.service.undoAction(apply?.id ?? '', undoApproval.value.id);
    expect(undone.ok).toBe(false);
    if (!undone.ok) {
      expect(undone.detail).toMatch(/locked by another writer/i);
    }
    expect(world.helper.calls.filter((call) => call.verb === 'undo')).toHaveLength(0);
    if (foreignOwner !== null) world.repositories.locks.release('root-1', foreignOwner);
  });

  it('a live heartbeating writer keeps its lease beyond the lease window', async () => {
    const world: World = makeWorld('lease-heartbeat');
    const approval = world.approve();

    // A writer with a SHORT lease whose single action outlives the window.
    const shortLease = new ApplicationService({
      repositories: createRepositories(join(world.dir, 'organiser.sqlite')),
      helper: world.helper,
      clock: () => new Date('2026-10-07T10:00:00.000Z'),
      destinations: world.destinations,
      lockLeaseMs: 300,
    });

    let release = (): void => {};
    const gate = new Promise<void>((resolveFn) => {
      release = resolveFn;
    });
    const realMoveAt = world.helper.moveAt.bind(world.helper);
    world.helper.moveAt = async (action, root, destination) => {
      await gate;
      return realMoveAt(action, root, destination);
    };

    const running = shortLease.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash);
    await new Promise((resolveFn) => setTimeout(resolveFn, 650));

    // Deep past the 300 ms window the heartbeat still holds the root.
    const observer = createRepositories(join(world.dir, 'organiser.sqlite'));
    const stolen = observer.locks.acquire('root-1', 300);
    expect(stolen).toBeNull();

    release();
    const result = await running;
    expect(result.results.every((entry) => entry.outcome === 'applied')).toBe(true);
    const afterDone = observer.locks.acquire('root-1', 300);
    expect(afterDone).not.toBeNull();
    if (afterDone !== null) observer.locks.release('root-1', afterDone);
    observer.close();
  }, 30_000);

  it("a dead writer's expired lease is taken over (process death)", async () => {
    const dir = tempDir('lease-death-');
    const dbPath = join(dir, 'organiser.sqlite');
    const projectRoot = resolve(import.meta.dirname, '../..');
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { createRepositories } = await import(${JSON.stringify(
          join(projectRoot, 'dist', 'adapters', 'persistence', 'repositories.js'),
        )});
        const repos = createRepositories(${JSON.stringify(dbPath)});
        repos.roots.insert({ id: 'root-1', canonicalPath: ${JSON.stringify(dir)}, device: '1', inode: '1', policyRevision: 1 });
        const owner = repos.locks.acquire('root-1', 1_200);
        console.log(owner === null ? 'ACQUIRE-FAILED' : 'HELD');
        setInterval(() => undefined, 60_000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('child did not report')), 20_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes('HELD') || out.includes('ACQUIRE-FAILED')) {
          clearTimeout(timer);
          res();
        }
      });
    });
    expect(out).toContain('HELD');

    // While alive, its lease is held: another writer must see it busy.
    const repos = createRepositories(dbPath);
    expect(repos.locks.acquire('root-1', 1_200)).toBeNull();

    // Actual process death, not a clock trick: SIGKILL and wait out the
    // heartbeat window, then the next writer legitimately takes over.
    child.kill('SIGKILL');
    await new Promise((res) => setTimeout(res, 1_500));
    const taken = repos.locks.acquire('root-1', 1_200);
    expect(taken).not.toBeNull();
    if (taken !== null) repos.locks.release('root-1', taken);
    repos.close();
  }, 40_000);
});
