/**
 * Shared synthetic workflow world for execution/recovery/authorisation tests.
 *
 * Everything lives in an OS temporary directory (never a pre-existing path and
 * never the real Downloads), the helper is a recording double around real
 * fixture moves, and crash points simulate process death at a helper
 * boundary. The fault vocabulary is declared by the application, not by this
 * helper.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect } from 'vitest';
import type { Destination, Item, MoveReceipt, Proposal, Result, RootConfig, Snapshot } from '../../src/domain/contracts.js';
import type { FilesystemHealth } from '../../src/adapters/filesystem/helper.js';
import type { ApplicationService, FaultPoint, HelperPort } from '../../src/application/workflow.js';
import { createRepositories } from '../../src/adapters/persistence/repositories.js';
import { ApplicationService as ApplicationServiceImpl } from '../../src/application/workflow.js';

const worlds: string[] = [];

afterAll(() => {
  for (const dir of worlds) rmSync(dir, { recursive: true, force: true });
});

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function snapshotOf(path: string, content: string | Buffer): Snapshot {
  // Identity is content-derived, like a real inode: it survives a rename, so
  // reconciliation can recognise a moved file at its new location.
  void path;
  return {
    device: '65026',
    inode: sha256Hex(content).slice(0, 12),
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

/** Real moves on the fixture root, with the helper's observable contract. */
export class RecordingHelper implements HelperPort {
  calls: { verb: string; actionId: string }[] = [];

  private expectCollision(action: { sourceBasename: string }, destination: Destination, root: RootConfig): boolean {
    return existsSync(join(root.absolutePath, ...destination.segments, action.sourceBasename));
  }

  async moveAt(
    action: { actionId: string; sourceBasename: string },
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

export interface World {
  dir: string;
  rootDir: string;
  repositories: ReturnType<typeof createRepositories>;
  /** The discovery catalogue the workflow validates destination pins against. */
  destinations: Map<string, Destination>;
  /** Simulates re-discovery replacing a destination directory's identity. */
  swapDestinationIdentity: (destinationId: string, device: string, inode: string) => void;
  root: RootConfig;
  batch: { id: string; rootId: string };
  items: Item[];
  proposals: Proposal[];
  helper: RecordingHelper;
  service: ApplicationService;
  approve: () => { approvalId: string; actionSetHash: string };
  restart: () => ApplicationService;
  advance: (ms: number) => void;
  crashAt: (point: FaultPoint, times?: number) => void;
  exists: (relative: string) => boolean;
  read: (relative: string) => string;
}

export function makeWorld(
  label: string,
  files: Record<string, string> = { 'invoice-01.txt': 'first invoice\n', 'invoice-02.txt': 'second invoice\n' },
): World {
  const dir = mkdtempSync(join(tmpdir(), `workflow-${label}-`));
  worlds.push(dir);
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
  const service = new ApplicationServiceImpl({
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
    new ApplicationServiceImpl({ repositories, helper, clock, destinations });

  return {
    dir,
    rootDir,
    repositories,
    destinations,
    swapDestinationIdentity(destinationId, device, inode) {
      const current = destinations.get(destinationId);
      if (current === undefined) throw new Error(`unknown destination ${destinationId}`);
      destinations.set(destinationId, { ...current, device, inode });
    },
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

/** Exactly one of source/target holds the expected bytes. */
export function assertExactlyOnce(world: World, basename: string, content: string): void {
  const atInbox = world.exists(basename);
  const atTarget = world.exists(`Documents/${basename}`);
  expect(atInbox !== atTarget).toBe(true);
  expect(world.read(atInbox ? basename : `Documents/${basename}`)).toBe(content);
}
