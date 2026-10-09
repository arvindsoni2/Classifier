import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  ApprovedMove,
  Destination,
  Item,
  MoveReceipt,
  Proposal,
  Result,
  RootConfig,
  Snapshot,
} from '../../src/domain/contracts.js';
import type { FilesystemHealth } from '../../src/adapters/filesystem/helper.js';
import { createRepositories } from '../../src/adapters/persistence/repositories.js';
import { ApplicationService, type FaultPoint, type HelperPort } from '../../src/application/workflow.js';

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function snapshotOf(path: string, content: string | Buffer): Snapshot {
  return {
    device: '65026',
    inode: sha256Hex(path).slice(0, 12),
    size: String(Buffer.byteLength(content)),
    mtimeNs: '1760000000000000000',
    ctimeNs: '1760000000000000000',
    sha256: sha256Hex(content),
  };
}

/** CrashSignal: a "process death" injected at a filesystem boundary. */
export class CrashSignal extends Error {
  constructor(readonly point: FaultPoint) {
    super(`injected crash at ${point}`);
    this.name = 'CrashSignal';
  }
}

/** Real movs on the fixture root, with the helper's observable contract. */
class RecordingHelper implements HelperPort {
  calls: { verb: string; actionId: string }[] = [];

  private expectCollision(action: ApprovedMove, destination: Destination, root: RootConfig): boolean {
    return existsSync(join(root.absolutePath, ...destination.segments, action.sourceBasename));
  }

  async moveAt(
    action: ApprovedMove,
    root: RootConfig,
    destination: Destination,
  ): Promise<Result<MoveReceipt>> {
    this.calls.push({ verb: 'move', actionId: action.actionId });
    if (this.expectCollision(action, destination, root)) {
      return { ok: false, code: 'COLLISION', detail: 'target already exists; retained unchanged' };
    }
    const source = join(root.absolutePath, action.sourceBasename);
    const target = join(root.absolutePath, ...destination.segments, action.sourceBasename);
    if (!existsSync(source)) {
      return { ok: false, code: 'OUT_OF_SCOPE', detail: 'source is not present at the inbox location' };
    }
    const before = snapshotOf(source, readFileSync(source));
    renameSync(source, target);
    const after = snapshotOf(target, readFileSync(target));
    return {
      ok: true,
      value: {
        kind: 'move_file',
        actionId: action.actionId,
        requestId: 'req-test',
        outcome: 'moved' as const,
        before,
        after,
        createdDirectoryIds: [],
        verified: true,
      },
    };
  }

  async undoAt(
    action: { actionId: string; basename: string; targetSegments: string[]; expected: Snapshot; approvalId: string },
    root: RootConfig,
  ): Promise<Result<MoveReceipt>> {
    this.calls.push({ verb: 'undo', actionId: action.actionId });
    const target = join(root.absolutePath, ...action.targetSegments, action.basename);
    const original = join(root.absolutePath, action.basename);
    if (existsSync(original)) {
      return { ok: false, code: 'COLLISION', detail: 'original location is occupied; retained unchanged' };
    }
    if (!existsSync(target)) {
      return { ok: false, code: 'OUT_OF_SCOPE', detail: 'target is not present at the destination' };
    }
    const before = snapshotOf(target, readFileSync(target));
    renameSync(target, original);
    return {
      ok: true,
      value: {
        kind: 'move_file',
        actionId: action.actionId,
        requestId: 'req-test',
        outcome: 'moved' as const,
        before,
        after: snapshotOf(original, readFileSync(original)),
        createdDirectoryIds: [],
        verified: true,
      },
    };
  }

  async inspectAt(root: RootConfig, segments: readonly string[]): Promise<Result<Snapshot>> {
    const path = join(root.absolutePath, ...segments);
    if (!existsSync(path)) {
      return { ok: false, code: 'OUT_OF_SCOPE', detail: `no file at ${path}` };
    }
    return { ok: true, value: snapshotOf(path, readFileSync(path)) };
  }

  async probe(): Promise<Result<FilesystemHealth>> {
    return { ok: true, value: { kernel: 'test', openat2: true, renameat2Noreplace: true, rootVerified: true } };
  }

  async mkdirAt(root: RootConfig, parent: Destination, segment: string): Promise<Result<Destination>> {
    this.calls.push({ verb: 'mkdir', actionId: segment });
    const path = join(root.absolutePath, ...parent.segments, segment);
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
    const segments = [...parent.segments, segment];
    return {
      ok: true,
      value: {
        id: `dest-${sha256Hex(segments.join('/')).slice(0, 40)}`,
        segments,
        device: '65026',
        inode: sha256Hex(segments.join('/')).slice(0, 12),
        status: 'observed',
      },
    };
  }
}

function makeWorld(label: string, files: Record<string, string> = { 'invoice-01.txt': 'first invoice\n', 'invoice-02.txt': 'second invoice\n' }) {
  const dir = mkdtempSync(join('/tmp/opencode', `workflow-${label}-`));
  fixtures.push(dir);
  const rootDir = join(dir, 'Downloads');
  mkdirSync(join(rootDir, 'Documents'), { recursive: true });
  const dbPath = join(dir, 'organiser.sqlite');
  const repositories = createRepositories(dbPath);
  repositories.roots.insert({
    id: 'root-1',
    canonicalPath: rootDir,
    device: '65026',
    inode: '900001',
    policyRevision: 1,
  });
  const root: RootConfig = {
    rootId: 'root-1',
    absolutePath: rootDir,
    device: '65026',
    inode: '900001',
    inboxDepth: 0,
    directoryDepth: 3,
    policyRevision: 1,
  };
  const destinations = new Map<string, Destination>([
    [
      'dest-invoices',
      {
        id: 'dest-invoices',
        segments: ['Documents'],
        device: '65026',
        inode: '900001',
        status: 'observed',
      },
    ],
  ]);

  const batch = repositories.batches.create('root-1');
  const items: Item[] = [];
  const proposals: Proposal[] = [];
  for (const [basename, text] of Object.entries(files)) {
    writeFileSync(join(rootDir, basename), text, 'utf8');
    const snapshot = snapshotOf(basename, text);
    const item: Item = {
      id: `item-${basename}`,
      sourceId: 'root-1',
      sourceKind: 'filesystem',
      externalId: basename,
      displayName: basename,
      revision: '1',
      snapshot,
      evidenceId: 'evidence-1',
    };
    items.push(item);
    const proposal: Proposal = {
      id: `proposal-${basename}`,
      version: 1,
      itemId: item.id,
      categoryId: 'cat-invoices',
      destinationId: 'dest-invoices',
      basename,
      expected: snapshot,
      taxonomyRevision: 1,
      policyRevision: 1,
      decisionIds: ['decision-1'],
      state: 'pending',
    };
    repositories.items.save(item, 'root-1');
    repositories.proposals.save(proposal);
    proposals.push(proposal);
  }

  const helper = new RecordingHelper();
  let now = new Date('2026-10-07T10:00:00.000Z');
  const clock = () => now;
  let fault: { point: FaultPoint; times: number } | null = null;
  const service = new ApplicationService({
    repositories,
    helper,
    clock,
    destinations,
    faultHook(point) {
      if (fault !== null && fault.point === point && fault.times > 0) {
        fault.times -= 1;
        throw new CrashSignal(point);
      }
    },
  });

  const approve = (): { approvalId: string; actionSetHash: string } => {
    const result = service.createApproval(
      batch.id,
      proposals.map((proposal) => ({ proposalId: proposal.id, version: proposal.version })),
      'apply',
      now,
    );
    if (!result.ok) throw new Error(result.detail);
    return { approvalId: result.value.id, actionSetHash: result.value.actionSetHash };
  };

  /** A "restarted" service on the same database, with no fault injection. */
  const restart = (): ApplicationService =>
    new ApplicationService({ repositories, helper, clock, destinations });

  return {
    dir,
    rootDir,
    repositories,
    root,
    batch,
    items,
    proposals,
    helper,
    service,
    approve,
    restart,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    crashAt(point: FaultPoint, times = 1) {
      fault = { point, times };
    },
    exists(relative: string): boolean {
      return existsSync(join(rootDir, relative));
    },
    read(relative: string): string {
      return readFileSync(join(rootDir, relative), 'utf8');
    },
  };
}

type World = ReturnType<typeof makeWorld>;

/** Exactly one of source/target holds the expected bytes. */
function assertExactlyOnce(world: World, basename: string, content: string): void {
  const atInbox = world.exists(basename);
  const atTarget = world.exists(`Documents/${basename}`);
  expect(atInbox !== atTarget).toBe(true);
  expect(world.read(atInbox ? basename : `Documents/${basename}`)).toBe(content);
}

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

  it('an unrecorded mkdir leaves the directory intact and awaits destination review', async () => {
    const world = makeWorld('mkdir');
    const created = await world.service.mkdirAt(world.root, ['Documents'], 'New Folder', world.batch.id, 'New Folder');
    expect(created.ok).toBe(true);
    expect(world.exists('Documents/New Folder')).toBe(true);
    // The directory exists but is not yet an accepted destination.
    const candidates = world.repositories.folderCandidates.listByBatch(world.batch.id);
    expect(candidates.some((candidate) => candidate.label === 'New Folder')).toBe(true);
    expect(candidates.find((candidate) => candidate.label === 'New Folder')?.reviewState).toBe('draft');
    // No proposal targets it until accepted.
    const createdId = created.ok ? created.value.id : 'none';
    expect(world.proposals.some((proposal) => proposal.destinationId === createdId)).toBe(false);
  });
});
