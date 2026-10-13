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
  totals: ScanTotals;
  elapsedMs: number;
}

/**
 * Hook for later phases. `onDirectory` receives every entry name in a directory
 * (including hidden ones, so `.git` can be noted) and may return `false` to
 * stop the scanner descending — how Task 3 stops at a bundle boundary.
 */
export interface ScanHooks {
  onDirectory?: (relPath: string, names: readonly string[]) => boolean | void;
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

/** Walks one root, recording directories and files, and returns its errors. */
async function scanRoot(
  config: CatalogueConfig,
  store: CatalogueStore,
  rootPath: string,
  scanId: number,
  totals: ScanTotals,
  hooks: ScanHooks,
): Promise<void> {
  const rootStat = await lstat(rootPath, { bigint: true });
  if (!rootStat.isDirectory()) {
    throw new Error(`root ${rootPath} is not a directory`);
  }
  const rootId = store.upsertRoot(rootPath, rootStat.dev.toString(), rootStat.ino.toString(), new Date().toISOString(), scanId);
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

    if (hooks.onDirectory?.(rel, listing.allNames) === false) {
      // A bundle boundary: recorded by the caller, never descended into.
      continue;
    }

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
  store.markMissingNotSeen(rootId, scanId);
  store.setRootLastScan(rootId, scanId);
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
  };

  try {
    for (const root of config.roots) {
      await scanRoot(config, store, root, scanId, totals, hooks);
    }
    store.finishScan(scanId, 'done', new Date().toISOString(), totals);
    return { scanId, roots: config.roots.length, totals, elapsedMs: Date.now() - started };
  } catch (error) {
    store.finishScan(scanId, 'failed', new Date().toISOString(), totals);
    throw error;
  }
}