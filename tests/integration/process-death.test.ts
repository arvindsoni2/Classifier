import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Destination, Result, RootConfig, Snapshot } from '../../src/domain/contracts.js';
import { createRepositories } from '../../src/adapters/persistence/repositories.js';
import { ApplicationService } from '../../src/application/workflow.js';

/**
 * Spec review F11: process death is tested by ACTUALLY killing a writer
 * process between the real rename and the journal commit — not by throwing
 * exceptions inside one process. A restarted service must reconcile from the
 * journal and never re-run the syscall.
 */
const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function snapshotOf(path: string): Snapshot {
  const st = statSync(path, { bigint: true });
  return {
    device: st.dev.toString(),
    inode: st.ino.toString(),
    size: st.size.toString(),
    mtimeNs: st.mtimeNs.toString(),
    ctimeNs: st.ctimeNs.toString(),
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}

// Runs against the COMPILED application (spawned tests run the dist build —
// the same code path a real CLI writer uses).
const CHILD_SCRIPT = `
const { createHash } = await import('node:crypto');
const fs = await import('node:fs');
const { join } = await import('node:path');
const dir = process.env.DEATH_DIR;
const { createRepositories } = await import(process.env.DIST + '/adapters/persistence/repositories.js');
const { ApplicationService } = await import(process.env.DIST + '/application/workflow.js');
const rootDir = join(dir, 'Downloads');
const repos = createRepositories(join(dir, 'organiser.sqlite'));
const rootStat = fs.statSync(rootDir, { bigint: true });
repos.roots.insert({ id: 'root-death', canonicalPath: rootDir, device: rootStat.dev.toString(), inode: rootStat.ino.toString(), policyRevision: 1 });
const snapOf = (p) => {
  const st = fs.statSync(p, { bigint: true });
  return { device: st.dev.toString(), inode: st.ino.toString(), size: st.size.toString(),
    mtimeNs: st.mtimeNs.toString(), ctimeNs: st.ctimeNs.toString(),
    sha256: createHash('sha256').update(fs.readFileSync(p)).digest('hex') };
};
const fileSnap = snapOf(join(rootDir, 'invoice-death.txt'));
repos.items.save({ id: 'item-death', sourceId: 'root-death', sourceKind: 'filesystem',
  externalId: 'invoice-death.txt', displayName: 'invoice-death.txt', revision: '1',
  snapshot: fileSnap, evidenceId: 'evidence-death' }, 'root-death');
repos.proposals.save({ id: 'proposal-death', version: 1, itemId: 'item-death', categoryId: 'cat-invoices',
  destinationId: 'dest-invoices', basename: 'invoice-death.txt', expected: fileSnap,
  taxonomyRevision: 1, policyRevision: 1, decisionIds: [], state: 'pending' });
const batch = repos.batches.create('root-death');
const destStat = fs.statSync(join(rootDir, 'Documents'), { bigint: true });
const destinations = new Map([['dest-invoices', { id: 'dest-invoices', segments: ['Documents'],
  device: destStat.dev.toString(), inode: destStat.ino.toString(), status: 'observed' }]]);
const helper = {
  async probe() { return { ok: true, value: { kernel: 'child', openat2: true, renameat2Noreplace: true, rootVerified: true } }; },
  async inspectAt(root, segments) {
    const p = join(root.absolutePath, ...segments);
    if (!fs.existsSync(p)) return { ok: false, code: 'NOT_FOUND', detail: 'absent' };
    const st = fs.statSync(p, { bigint: true });
    return { ok: true, value: { device: st.dev.toString(), inode: st.ino.toString(), size: st.size.toString(),
      mtimeNs: st.mtimeNs.toString(), ctimeNs: st.ctimeNs.toString(),
      sha256: createHash('sha256').update(fs.readFileSync(p)).digest('hex') } };
  },
  async moveAt(action, root, destination) {
    // The REAL rename happens; then this process dies before any commit.
    fs.renameSync(join(root.absolutePath, action.sourceBasename),
      join(root.absolutePath, ...destination.segments, action.sourceBasename));
    process.exit(0);
  },
  async undoAt() { return { ok: false, code: 'UNSUPPORTED', detail: 'unused' }; },
  async mkdirAt() { return { ok: false, code: 'UNSUPPORTED', detail: 'unused' }; },
};
const now = new Date('2026-10-12T10:00:00.000Z');
const service = new ApplicationService({ repositories: repos, helper, clock: () => now, destinations, lockLeaseMs: 1_500 });
const approved = service.createApproval(batch.id, [{ proposalId: 'proposal-death', version: 1 }], 'apply', now);
if (!approved.ok) { console.error('approval failed'); process.exit(1); }
fs.writeFileSync(join(dir, 'state.json'), JSON.stringify({ batchId: batch.id, approvalId: approved.value.id }));
await service.applyBatch(batch.id, approved.value.id, approved.value.actionSetHash);
process.exit(2);
`;

describe('real process death (F11)', () => {
  it('a killed writer process reconciles to applied with no second move', async () => {
    const projectRoot = resolve(import.meta.dirname, '../..');
    if (!existsSync(join(projectRoot, 'dist', 'application', 'workflow.js'))) {
      throw new Error('dist is not built; run "pnpm build" before this suite');
    }
    const dir = mkdtempSync(join(tmpdir(), 'death-'));
    fixtures.push(dir);
    const rootDir = join(dir, 'Downloads');
    mkdirSync(join(rootDir, 'Documents'), { recursive: true });
    writeFileSync(join(rootDir, 'invoice-death.txt'), 'killed mid apply\n', 'utf8');

    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT], {
      env: { ...process.env, DEATH_DIR: dir, DIST: join(projectRoot, 'dist') },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const exitCode = await new Promise<number | null>((done) => child.on('exit', done));
    // The child died INSIDE the move, after the real rename and before any commit.
    expect(exitCode).toBe(0);

    // The file really moved, and the journal is mid-flight.
    expect(existsSync(join(rootDir, 'Documents', 'invoice-death.txt'))).toBe(true);
    expect(existsSync(join(rootDir, 'invoice-death.txt'))).toBe(false);

    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { batchId: string };
    const repositories = createRepositories(join(dir, 'organiser.sqlite'));
    const interrupted = repositories.actions.find('proposal-death', 1, 'apply');
    expect(interrupted).not.toBeNull();
    expect(['planned', 'intent']).toContain(interrupted?.state);

    // A fresh writer takes over once the dead holder's lease expires (it
    // stopped heartbeating), reconciles from the journal, and MUST NOT move
    // again: its helper refuses any move call.
    const destStat = statSync(join(rootDir, 'Documents'), { bigint: true });
    const destinations = new Map<string, Destination>([[
      'dest-invoices',
      {
        id: 'dest-invoices',
        segments: ['Documents'],
        device: destStat.dev.toString(),
        inode: destStat.ino.toString(),
        status: 'observed',
      },
    ]]);
    let moved = 0;
    const helper = {
      async probe(): Promise<Result<never>> {
        return { ok: false, code: 'UNSUPPORTED', detail: 'unused' };
      },
      async inspectAt(_root: RootConfig, segments: readonly string[]): Promise<Result<Snapshot>> {
        const p = join(rootDir, ...segments);
        if (!existsSync(p)) return { ok: false, code: 'NOT_FOUND', detail: 'absent' };
        return { ok: true, value: snapshotOf(p) };
      },
      async moveAt(): Promise<Result<never>> {
        moved += 1;
        return { ok: false, code: 'UNSUPPORTED', detail: 'no second syscall may run' };
      },
      async undoAt(): Promise<Result<never>> {
        return { ok: false, code: 'UNSUPPORTED', detail: 'unused' };
      },
      async mkdirAt(): Promise<Result<never>> {
        return { ok: false, code: 'UNSUPPORTED', detail: 'unused' };
      },
    };
    const service = new ApplicationService({
      repositories,
      helper: helper as unknown as ConstructorParameters<typeof ApplicationService>[0]['helper'],
      clock: () => new Date(),
      destinations,
      lockLeaseMs: 1_500,
    });

    let resumed = await service.resumeBatch(state.batchId);
    const deadline = Date.now() + 10_000;
    while (resumed.results.some((entry) => /locked/i.test(entry.detail ?? '')) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 400));
      resumed = await service.resumeBatch(state.batchId);
    }
    const outcome = resumed.results.find((entry) => entry.proposalId === 'proposal-death');
    expect(outcome?.outcome).toBe('applied');
    expect(moved).toBe(0);
    // The journal now carries the rebuilt receipt; the file sits once.
    const after = repositories.actions.find('proposal-death', 1, 'apply');
    expect(after?.state).toBe('applied');
    const expected = snapshotOf(join(rootDir, 'Documents', 'invoice-death.txt'));
    expect(after?.receiptJson).toContain(expected.sha256);
    repositories.close();
  }, 60_000);
});
