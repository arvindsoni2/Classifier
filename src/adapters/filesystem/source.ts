/**
 * Scoped read-only discovery and stable snapshots (LLD §1, plan Task 2).
 *
 * Discovery is read-only, depth zero for the inbox and depth three for
 * destination directories. No symlink traversal, no mount crossing.
 * A file is eligible only after size and mtime remain unchanged across two
 * observations at least five seconds apart (PRD §3) — a heuristic, not a
 * guarantee. Mutations are not possible from this module: `apply` is
 * UNSUPPORTED until the verified anchored Linux helper lands (plan Task 7).
 */
import { createHash } from 'node:crypto';
import type { BigIntStats, Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { access, constants, lstat, open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  err,
  ok,
  validateSnapshot,
  type ActionReceipt,
  type ApprovedAction,
  type Destination,
  type Id,
  type Item,
  type Result,
  type RootConfig,
  type Snapshot,
  type SourceAdapter,
  type SourceCapabilities,
} from '../../domain/contracts.js';

/** Candidate batch size per discovery page (PRD §6). */
export const CANDIDATE_PAGE_SIZE = 200;
/** Minimum spacing between the two stability observations (PRD §3). */
export const STABILITY_WINDOW_MS = 5_000;
/** SHA-256 candidate eligibility and move ceiling: 100 MiB (PRD §6). */
export const MAX_CANDIDATE_BYTES = 100 * 1024 * 1024;

/** In-progress download suffixes are excluded from candidacy (PRD §3). */
const EXCLUDED_SUFFIXES = ['.part', '.crdownload', '.download', '.tmp'];

/** Injectable clock so tests exercise the stability window deterministically. */
export interface DiscoveryClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: DiscoveryClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }),
};

/** Minimal directory identity for scope checks. */
interface DirectoryStat {
  dev: number;
  ino: number;
}

/** Injectable seams; `stat` exists so tests can simulate cross-mount directories. */
export interface FilesystemDeps {
  clock?: DiscoveryClock;
  stat?: (path: string) => Promise<DirectoryStat>;
}

function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return typeof e === 'object' && e !== null && 'code' in e;
}

function sha(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function detailOf(e: unknown): string {
  return isErrnoException(e) ? `${e.code} ${e.message}` : 'unknown error';
}

/** Streams at most `size` bytes through SHA-256 in 1 MiB chunks. */
async function hashHandle(handle: FileHandle, size: number): Promise<string> {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(1024 * 1024);
  let position = 0;
  while (position < size) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - position), position);
    if (bytesRead === 0) break;
    hash.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

/** Builds a snapshot from an adapter-owned opened handle, never a UI path. */
export async function snapshot(handle: FileHandle): Promise<Result<Snapshot>> {
  // bigint mode: this Node line only materialises *Ns fields with bigint:true.
  const st = await handle.stat({ bigint: true });
  if (st.size > MAX_CANDIDATE_BYTES) {
    return err(
      'OVERSIZE',
      `file is ${st.size} bytes, above the ${MAX_CANDIDATE_BYTES}-byte eligibility ceiling`,
    );
  }
  const sha256 = await hashHandle(handle, Number(st.size));
  const snap: Snapshot = {
    device: st.dev.toString(),
    inode: st.ino.toString(),
    size: st.size.toString(),
    mtimeNs: st.mtimeNs.toString(),
    ctimeNs: st.ctimeNs.toString(),
    sha256,
  };
  const validated = validateSnapshot(snap);
  if (!validated.ok) return validated;
  return ok(snap);
}

export class FilesystemSource implements SourceAdapter {
  private readonly clock: DiscoveryClock;
  private readonly statPath: (path: string) => Promise<DirectoryStat>;
  /** itemId -> path for items discovered by this instance (inspect support). */
  private readonly itemPaths = new Map<Id, string>();

  constructor(deps: FilesystemDeps = {}) {
    this.clock = deps.clock ?? realClock;
    this.statPath = deps.stat ?? stat;
  }

  /**
   * Mutation capability: the anchored Linux helper (Task 7) and the
   * journalled executor (Task 8) are verified, so the filesystem source
   * advertises the reviewed move and its recovery mode. The HTTP surface
   * still gates every apply through explicit approval.
   */
  capabilities(): SourceCapabilities {
    return { actions: ['move_file'], recovery: 'reconcile_and_reverse' };
  }

  async inspect(itemId: Id): Promise<Result<Snapshot>> {
    const path = this.itemPaths.get(itemId);
    if (path === undefined) {
      return err('OUT_OF_SCOPE', `unknown item ${itemId}; discover first or load from the catalogue`);
    }
    try {
      const handle = await open(path, 'r');
      try {
        return await snapshot(handle);
      } finally {
        await handle.close();
      }
    } catch (e) {
      return err('OUT_OF_SCOPE', `cannot inspect ${path}: ${detailOf(e)}`);
    }
  }

  async apply(_action: ApprovedAction): Promise<Result<ActionReceipt>> {
    return err(
      'UNSUPPORTED',
      'filesystem moves require the verified anchored Linux helper (plan Task 7); Milestone A is read-only',
    );
  }

  /** Verifies the root still has its recorded identity before any reading. */
  private async rootStat(config: RootConfig): Promise<Result<DirectoryStat>> {
    let st: DirectoryStat;
    try {
      st = await this.statPath(config.absolutePath);
    } catch (e) {
      return err('OUT_OF_SCOPE', `root ${config.absolutePath} is unreadable: ${detailOf(e)}`);
    }
    if (st.dev.toString() !== config.device || st.ino.toString() !== config.inode) {
      return err(
        'OUT_OF_SCOPE',
        `root identity mismatch at ${config.absolutePath}: recorded ${config.device}:${config.inode}, ` +
          `found ${st.dev}:${st.ino}; refusing to read a replaced root`,
      );
    }
    return ok(st);
  }

  /**
   * Read-only inbox discovery at depth zero. Yields one result per direct
   * entry: eligible stable candidates as ok Items, everything else as an
   * error result naming the entry and its exclusion reason. Page zero also
   * reports exclusions; further pages continue the eligible candidates.
   */
  async *discover(config: RootConfig, page = 0): AsyncIterable<Result<Item>> {
    const pageNumber = Math.max(0, Math.floor(page));
    const root = await this.rootStat(config);
    if (!root.ok) {
      yield root;
      return;
    }

    let entries: Dirent[];
    try {
      entries = await readdir(config.absolutePath, { withFileTypes: true });
    } catch (e) {
      yield err('OUT_OF_SCOPE', `root ${config.absolutePath} cannot be listed: ${detailOf(e)}`);
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const exclusions: Result<Item>[] = [];
    const candidates: { name: string; first: BigIntStats }[] = [];

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        exclusions.push(err('OUT_OF_SCOPE', `${entry.name}: symlink, not a direct regular file`));
        continue;
      }
      if (!entry.isFile()) {
        exclusions.push(
          err(
            'OUT_OF_SCOPE',
            `${entry.name}: not a regular file (${entry.isDirectory() ? 'directory' : 'special file'})`,
          ),
        );
        continue;
      }
      if (entry.name.startsWith('.')) {
        exclusions.push(err('OUT_OF_SCOPE', `${entry.name}: hidden name`));
        continue;
      }
      if (EXCLUDED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
        exclusions.push(err('OUT_OF_SCOPE', `${entry.name}: in-progress download suffix`));
        continue;
      }
      try {
        const first = await lstat(join(config.absolutePath, entry.name), { bigint: true });
        const exclusion = this.classifyStat(entry.name, first);
        if (exclusion !== null) {
          exclusions.push(exclusion);
          continue;
        }
        candidates.push({ name: entry.name, first });
      } catch (e) {
        exclusions.push(err('UNSTABLE', `${entry.name}: vanished before observation (${detailOf(e)})`));
      }
    }

    // One stability window per batch: two observations >= 5 s apart.
    await this.clock.sleep(STABILITY_WINDOW_MS);

    const settled: { name: string; second: BigIntStats }[] = [];
    for (const candidate of candidates) {
      try {
        const second = await lstat(join(config.absolutePath, candidate.name), { bigint: true });
        const stable =
          second.dev.toString() === candidate.first.dev.toString() &&
          second.ino.toString() === candidate.first.ino.toString() &&
          second.size.toString() === candidate.first.size.toString() &&
          second.mtimeNs.toString() === candidate.first.mtimeNs.toString();
        if (!stable) {
          exclusions.push(
            err('UNSTABLE', `${candidate.name}: size or mtime changed across the stability window`),
          );
          continue;
        }
        const exclusion = this.classifyStat(candidate.name, second);
        if (exclusion !== null) {
          exclusions.push(exclusion);
          continue;
        }
        settled.push({ name: candidate.name, second });
      } catch (e) {
        exclusions.push(err('UNSTABLE', `${candidate.name}: vanished during the stability window (${detailOf(e)})`));
      }
    }

    const items: Item[] = [];
    for (const { name, second } of settled) {
      const item = await this.buildItem(config, name, second);
      if (item.ok) items.push(item.value);
      else exclusions.push(item);
    }

    if (pageNumber === 0) {
      for (const exclusion of exclusions) yield exclusion;
    }
    for (const item of items.slice(
      pageNumber * CANDIDATE_PAGE_SIZE,
      (pageNumber + 1) * CANDIDATE_PAGE_SIZE,
    )) {
      yield ok(item);
    }
  }

  /** Size/hard-link ceilings shared by both observation passes. */
  private classifyStat(name: string, st: BigIntStats): Result<Item> | null {
    if (st.nlink > 1) {
      return err('OUT_OF_SCOPE', `${name}: ${st.nlink} hard links; not an eligible single-link file`);
    }
    if (st.size > MAX_CANDIDATE_BYTES) {
      return err(
        'OVERSIZE',
        `${name}: ${st.size} bytes exceeds the 100 MiB candidate ceiling; listed but not eligible`,
      );
    }
    return null;
  }

  private async buildItem(
    config: RootConfig,
    name: string,
    second: BigIntStats,
  ): Promise<Result<Item>> {
    const path = join(config.absolutePath, name);
    let handle: FileHandle;
    try {
      handle = await open(path, 'r');
    } catch (e) {
      return err('OUT_OF_SCOPE', `${name}: unreadable (${detailOf(e)}); excluded`);
    }
    try {
      const fstat = await handle.stat({ bigint: true });
      if (
        fstat.ino.toString() !== second.ino.toString() ||
        fstat.dev.toString() !== second.dev.toString() ||
        fstat.size.toString() !== second.size.toString()
      ) {
        return err('UNSTABLE', `${name}: identity changed between observation and hashing`);
      }
      if (fstat.size > MAX_CANDIDATE_BYTES) {
        return err(
          'OVERSIZE',
          `${name}: ${fstat.size} bytes exceeds the 100 MiB candidate ceiling; listed but not eligible`,
        );
      }
      const sha256 = await hashHandle(handle, Number(fstat.size));
      const after = await handle.stat({ bigint: true });
      if (
        after.size !== fstat.size ||
        after.mtimeNs !== fstat.mtimeNs ||
        after.ctimeNs !== fstat.ctimeNs
      ) {
        return err('UNSTABLE', `${name}: changed while being hashed`);
      }
      const snap: Snapshot = {
        device: fstat.dev.toString(),
        inode: fstat.ino.toString(),
        size: fstat.size.toString(),
        mtimeNs: fstat.mtimeNs.toString(),
        ctimeNs: fstat.ctimeNs.toString(),
        sha256,
      };
      const validated = validateSnapshot(snap);
      if (!validated.ok) return validated;
      const revision = sha(
        `${snap.device}|${snap.inode}|${snap.size}|${snap.mtimeNs}|${snap.ctimeNs}|${snap.sha256}`,
      );
      const id = `item-${sha(`${config.rootId}|${name}|${revision}`).slice(0, 40)}`;
      this.itemPaths.set(id, path);
      return ok({
        id,
        sourceId: config.rootId,
        sourceKind: 'filesystem',
        externalId: name,
        displayName: name,
        revision,
        snapshot: snap,
        evidenceId: null,
      });
    } finally {
      await handle.close();
    }
  }

  /**
   * Destination directory discovery to depth three beneath the root.
   * Symlinks are never traversed; directories on another device are skipped
   * (cross-mount is deferred, never followed); unreadable subtrees are
   * skipped while the rest of the tree is still reported.
   */
  async discoverDirectories(config: RootConfig): Promise<Result<Destination[]>> {
    const root = await this.rootStat(config);
    if (!root.ok) return root;

    const destinations: Destination[] = [];
    const queue: { path: string; segments: string[]; depth: number }[] = [
      { path: config.absolutePath, segments: [], depth: 0 },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      let entries: Dirent[];
      try {
        entries = await readdir(current.path, { withFileTypes: true });
      } catch (e) {
        if (current.depth > 0 && isErrnoException(e) && e.code === 'EACCES') {
          continue; // unreadable SUBTREE: skip, keep reporting the rest
        }
        // An unlistable ROOT is an explicit error: an empty catalogue would
        // be indistinguishable from "the user has no folders".
        return err('OUT_OF_SCOPE', `cannot list root ${current.path}: ${detailOf(e)}`);
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
        const childDepth = current.depth + 1;
        if (childDepth > config.directoryDepth) continue;
        const path = join(current.path, entry.name);
        let st: DirectoryStat;
        try {
          st = await this.statPath(path);
          await access(path, constants.R_OK);
        } catch {
          continue; // unreadable or vanished directory: skip
        }
        if (st.dev.toString() !== config.device) {
          continue; // CROSS_MOUNT: deferred, no fallback
        }
        const segments = [...current.segments, entry.name];
        destinations.push({
          id: `dest-${sha(JSON.stringify(segments)).slice(0, 40)}`,
          segments,
          device: st.dev.toString(),
          inode: st.ino.toString(),
          status: 'observed',
        });
        if (childDepth < config.directoryDepth) {
          queue.push({ path, segments, depth: childDepth });
        }
      }
    }
    return ok(destinations);
  }
}
