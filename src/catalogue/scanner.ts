/**
 * Read-only recursive catalogue scanner (spec §7.1, plan Task 1).
 *
 * Every rule here exists to make the walk safe and honest:
 *  - iterative, so a deep tree cannot overflow the stack;
 *  - symlinks are counted and never followed, never recorded;
 *  - a directory on another device is an error row, never entered;
 *  - sockets, FIFOs and devices are skipped;
 *  - excluded and hidden names are not catalogued;
 *  - rows are written in batches, so memory does not grow with the tree;
 *  - unchanged items keep their hashes and unseen items become `missing`.
 *
 * Nothing in this module creates, moves, modifies or deletes anything inside a
 * root: files are opened read-only for at most 16 bytes.
 */
import { opendir, open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { matchesExclude, type CatalogueConfig } from './config.js';
import { detectKind, extensionOf, MAGIC_PREFIX_BYTES } from './kinds.js';
import type { CatalogueStore, DirRow, ItemRow, ItemStatus, ScanTotals } from './store.js';

export interface ScanResult {
  scanId: number;
  /** Number of roots scanned. */
  roots: number;
  /** Roots a probe found present and walked. */
  rootsOnline: number;
  /** Roots a probe reported missing: skipped, with no item touched. */
  rootsOffline: number;
  totals: ScanTotals;
  elapsedMs: number;
}

/**
 * What a probe found about the filesystem a path sits on.
 *
 * `uuid` is null for filesystems that have none (vfat, and some FUSE mounts) —
 * which is exactly why it cannot be the only identity signal.
 */
export interface VolumeInfo {
  uuid: string | null;
  label: string | null;
  fstype: string;
  mountPoint: string;
}

/**
 * Reports the filesystem at `path`, or null when the path does not exist.
 *
 * Task 1a only defines the seam and records what it is told; the real probe
 * (findmnt) and the offline / volume-changed / path-mode decisions belong to
 * Task 1b, so a scan without a probe behaves exactly as it did before.
 */
export type VolumeProbe = (path: string) => Promise<VolumeInfo | null>;

/** Filesystems where an inode number identifies a file across scans. */
const INODE_IDENTITY_FS: ReadonlySet<string> = new Set(['ext4', 'xfs', 'btrfs', 'f2fs', 'ext3', 'ext2']);

/** Inode|path: the only thing a filesystem type decides here. */
export function identityModeFor(fstype: string): 'inode' | 'path' {
  return INODE_IDENTITY_FS.has(fstype) ? 'inode' : 'path';
}

/** One directory as the scanner sees it, handed to `onDirectory`. */
export interface ScanDirectoryContext {
  rootId: number;
  scanId: number;
  /** Path relative to the root; empty string for the root itself. */
  relPath: string;
  /** Absolute path, for callers that need to stat it. */
  absPath: string;
  /** Every entry name, including hidden ones, so `.git` is visible. */
  names: readonly string[];
}

/**
 * Hooks and seams for a scan. `onDirectory` receives the directory's listing and
 * may return `false` to stop the scanner descending — how Task 3 stops at a
 * bundle boundary. `volumeProbe` is asked once per root.
 */
export interface ScanHooks {
  onDirectory?: (dir: ScanDirectoryContext) => boolean | void;
  volumeProbe?: VolumeProbe;
}

interface PendingDir {
  rootId: number;
  relPath: string;
  absPath: string;
}

interface Listing {
  /** Names of regular files, hidden and excluded entries removed. */
  files: string[];
  /** Names of subdirectories worth entering, in the same order. */
  dirs: string[];
  /** All entry names, for the bundle hook. */
  allNames: string[];
  /** Symlinks seen but never followed and never recorded. */
  symlinks: number;
  fileCount: number;
  dirCount: number;
}

/** Rows are inserted in batches of this size (plan Task 1 rule 8). */
const BATCH_ROWS = 1_000;

const INCOMPLETE_EXTENSIONS: ReadonlySet<string> = new Set(['part', 'crdownload', 'download', 'tmp']);

/**
 * A directory containing this file is a Python virtualenv and is not entered.
 *
 * Content, not name, is the signal: `.venv` and `venv` are already in the
 * default exclude list, and the environments that actually exist are named
 * `env1`, `myenv`, `pytorch_env`. `pyvenv.cfg` is written by `python -m venv`
 * and by no ordinary directory, so one entry in a listing is enough.
 */
const VIRTUALENV_MARKER = 'pyvenv.cfg';

function isHidden(name: string): boolean {
  return name.startsWith('.');
}

function statusFor(name: string): ItemStatus {
  return INCOMPLETE_EXTENSIONS.has(extensionOf(name)) ? 'incomplete' : 'present';
}

/** Reads at most `MAGIC_PREFIX_BYTES` from the head of a file. */
async function readHead(absPath: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(absPath, 'r');
    const buffer = Buffer.alloc(MAGIC_PREFIX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAGIC_PREFIX_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    // Unreadable at open time: the caller's lstat error path already recorded it.
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * Walks one root, recording directories and files, and returns its errors.
 * Returns the root's status: `offline` when a probe says the path is not there,
 * in which case nothing below was touched.
 */
async function scanRoot(
  config: CatalogueConfig,
  store: CatalogueStore,
  rootPath: string,
  scanId: number,
  totals: ScanTotals,
  hooks: ScanHooks,
): Promise<'online' | 'offline'> {
  const startedAt = new Date().toISOString();
  const volume = hooks.volumeProbe === undefined ? null : await hooks.volumeProbe(rootPath);

  // Offline: the root is not there. It is recorded and skipped without touching a
  // single item — an absent drive is not a deleted directory, and marking its
  // files missing would be the most destructive thing this scan could do.
  if (hooks.volumeProbe !== undefined && volume === null) {
    const offlineId = store.upsertRoot(rootPath, '0', '0', startedAt, scanId);
    store.setRootVolume(offlineId, {
      status: 'offline',
      volumeUuid: null,
      volumeLabel: null,
      fstype: null,
      mountPoint: null,
      isMountPoint: null,
      identityMode: null,
      // Deliberately unchanged: the last time this drive was actually readable.
      lastOnlineAt: null,
    });
    store.recordScanRoot({ scanId, rootId: offlineId, path: rootPath, status: 'offline', fstype: null });
    store.setRootLastScan(offlineId, scanId);
    return 'offline';
  }

  const rootStat = await lstat(rootPath, { bigint: true });
  if (!rootStat.isDirectory()) {
    throw new Error(`root ${rootPath} is not a directory`);
  }
  const rootId = store.upsertRoot(
    rootPath,
    rootStat.dev.toString(),
    rootStat.ino.toString(),
    startedAt,
    scanId,
  );
  if (volume !== null) {
    store.setRootVolume(rootId, {
      status: 'online',
      volumeUuid: volume.uuid,
      volumeLabel: volume.label,
      fstype: volume.fstype,
      mountPoint: volume.mountPoint,
      isMountPoint: volume.mountPoint === rootPath,
      identityMode: identityModeFor(volume.fstype),
      lastOnlineAt: startedAt,
    });
    store.recordScanRoot({ scanId, rootId, path: rootPath, status: 'online', fstype: volume.fstype });
  }
  const rootDev = rootStat.dev;

  const stack: PendingDir[] = [{ rootId, relPath: '', absPath: rootPath }];
  let itemBuffer: ItemRow[] = [];
  let errorBuffer: { scanId: number; rootId: number; relPath: string; code: string; message: string }[] = [];

  const flush = (): void => {
    if (itemBuffer.length > 0) {
      store.upsertItems(itemBuffer);
      itemBuffer = [];
    }
    if (errorBuffer.length > 0) {
      store.addErrors(errorBuffer);
      errorBuffer = [];
    }
  };

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    const rel = current.relPath;

    let listing: Listing;
    try {
      listing = await listDirectory(current.absPath, config.exclude);
    } catch (error) {
      // An unreadable directory is recorded and the scan continues (rule 7).
      errorBuffer.push({
        scanId,
        rootId,
        relPath: rel,
        code: errorCode(error),
        message: messageOf(error),
      });
      totals.errors += 1;
      continue;
    }
    totals.symlinksSeen += listing.symlinks;

    // A Python virtualenv is skipped the way an excluded name is: not entered,
    // nothing recorded. It is recognised by its contents rather than its name,
    // because `venv` and `.venv` are already in the exclude list and nobody
    // calls their environment `venv` — on Arvind's roots these held 19,287 of
    // 23,323 items, mostly headers and duplicated library files.
    if (rel !== '' && listing.allNames.includes(VIRTUALENV_MARKER)) {
      totals.virtualenvsSkipped += 1;
      continue;
    }

    const boundary = hooks.onDirectory?.({ rootId, scanId, relPath: rel, absPath: current.absPath, names: listing.allNames }) === false;

    try {
      const stat = await lstat(current.absPath, { bigint: true });
      const dirRow: DirRow = {
        rootId,
        relPath: rel,
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        fileCount: listing.fileCount,
        dirCount: listing.dirCount,
        lastSeenScan: scanId,
      };
      const dirId = store.upsertDir(dirRow);
      totals.dirsSeen += 1;

      if (boundary) {
        // A bundle directory is recorded and counted, but nothing inside it is
        // catalogued: no items, no child directories, no descent.
        totals.bundlesSeen += 1;
        continue;
      }

      for (const name of listing.dirs) {
        const childRel = rel === '' ? name : `${rel}/${name}`;
        const childAbs = join(current.absPath, name);
        let stat;
        try {
          stat = await lstat(childAbs, { bigint: true });
        } catch (error) {
          errorBuffer.push({ scanId, rootId, relPath: childRel, code: errorCode(error), message: messageOf(error) });
          totals.errors += 1;
          continue;
        }
        if (stat.dev !== rootDev) {
          // Spec §7.5: never cross a mount boundary below a root.
          errorBuffer.push({
            scanId,
            rootId,
            relPath: childRel,
            code: 'MOUNT_BOUNDARY',
            message: `device ${stat.dev} differs from root device ${rootDev}; not entered`,
          });
          totals.errors += 1;
          continue;
        }
        stack.push({ rootId, relPath: childRel, absPath: childAbs });
      }

      for (const name of listing.files) {
        const childRel = rel === '' ? name : `${rel}/${name}`;
        const childAbs = join(current.absPath, name);
        let stat;
        try {
          stat = await lstat(childAbs, { bigint: true });
        } catch (error) {
          errorBuffer.push({ scanId, rootId, relPath: childRel, code: errorCode(error), message: messageOf(error) });
          totals.errors += 1;
          continue;
        }
        const head = await readHead(childAbs);
        itemBuffer.push({
          rootId,
          relPath: childRel,
          dirId,
          name,
          ext: extensionOf(name),
          kind: detectKind(name, head),
          size: Number(stat.size),
          mtimeNs: stat.mtimeNs.toString(),
          dev: stat.dev.toString(),
          ino: stat.ino.toString(),
          nlink: Number(stat.nlink),
          status: statusFor(name),
          scanId,
        });
        totals.filesSeen += 1;
        totals.bytesSeen += Number(stat.size);

        if (itemBuffer.length >= BATCH_ROWS || errorBuffer.length >= BATCH_ROWS) flush();
      }
    } catch (error) {
      errorBuffer.push({ scanId, rootId, relPath: rel, code: errorCode(error), message: messageOf(error) });
      totals.errors += 1;
    }

    if (itemBuffer.length >= BATCH_ROWS || errorBuffer.length >= BATCH_ROWS) flush();
  }

  flush();
  // Only a root that was actually walked may retire its unseen items. The
  // offline path returns before reaching here, which is what stops an unplugged
  // drive from marking everything it holds as missing.
  store.markMissingNotSeen(rootId, scanId);
  store.setRootLastScan(rootId, scanId);
  return 'online';
}

/** One directory's listing, filtered and classified. */
async function listDirectory(absPath: string, exclude: readonly string[]): Promise<Listing> {
  const files: string[] = [];
  const dirs: string[] = [];
  const allNames: string[] = [];
  let symlinks = 0;
  const dir = await opendir(absPath);
  for await (const entry of dir) {
    allNames.push(entry.name);
    if (entry.isSymbolicLink()) {
      // Counted for the totals; nothing is recorded and nothing is followed.
      symlinks += 1;
      continue;
    }
    if (matchesExclude(entry.name, exclude)) continue;
    if (entry.isFile()) {
      if (isHidden(entry.name)) continue;
      files.push(entry.name);
      continue;
    }
    if (entry.isDirectory()) {
      if (isHidden(entry.name)) continue;
      dirs.push(entry.name);
      continue;
    }
    // Sockets, FIFOs, character and block devices: skipped by design.
  }
  return { files, dirs, allNames, symlinks, fileCount: files.length, dirCount: dirs.length };
}

/** Best-effort error classification; the message is kept verbatim. */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

function messageOf(error: unknown): string {
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : String(error);
}

/**
 * Scans every configured root into the catalogue. Read-only on the roots; the
 * only writes are to the catalogue database.
 */
export async function scan(
  config: CatalogueConfig,
  store: CatalogueStore,
  hooks: ScanHooks = {},
): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const scanId = store.startScan(startedAt);
  const totals: ScanTotals = {
    filesSeen: 0,
    dirsSeen: 0,
    bytesSeen: 0,
    filesHashed: 0,
    errors: 0,
    symlinksSeen: 0,
    bundlesSeen: 0,
    virtualenvsSkipped: 0,
  };

  try {
    let rootsOnline = 0;
    let rootsOffline = 0;
    for (const root of config.roots) {
      const status = await scanRoot(config, store, root, scanId, totals, hooks);
      if (status === 'online') rootsOnline += 1;
      else rootsOffline += 1;
    }
    store.finishScan(scanId, 'done', new Date().toISOString(), totals);
    return { scanId, roots: config.roots.length, rootsOnline, rootsOffline, totals, elapsedMs: Date.now() - started };
  } catch (error) {
    store.finishScan(scanId, 'failed', new Date().toISOString(), totals);
    throw error;
  }
}