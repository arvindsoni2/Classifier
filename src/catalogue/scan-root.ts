/**
 * Walking one root: what the scanner sees, and what it writes down.
 *
 * Split from `scanner.ts` (which owns the scan's lifecycle and its pipeline
 * stages) because "where does this go next" and "when does a scan count as
 * finished" are different questions, and because the walk's rules are worth
 * reading on their own:
 *
 *  - iterative, so a deep tree cannot overflow the stack;
 *  - symlinks are counted and never followed, never recorded;
 *  - a directory on another device is an error row, never entered;
 *  - sockets, FIFOs and devices are skipped, and anything that turns out not to
 *    be a regular file between the listing and the open is an error row;
 *  - excluded and hidden names are not catalogued;
 *  - rows are written in batches, so memory does not grow with the tree;
 *  - unchanged items keep their hashes and unseen items become `missing` — except
 *    under a directory whose listing failed, which taught us nothing.
 *
 * Nothing in this module creates, moves, modifies or deletes anything inside a
 * root: files are opened read-only, for at most 16 bytes, through `openRegularFile`.
 */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { type CatalogueConfig } from './config.js';
import { detectKind, extensionOf, MAGIC_PREFIX_BYTES } from './kinds.js';
import { listDirectory, type Listing } from './list-directory.js';
import { openRegularFile } from './open.js';
import { decideRoot, identityModeFor, type KnownRoot } from './volume.js';
import type { CatalogueStore, DirRow, ItemRow, ItemStatus, ScanTotals } from './store.js';
import type { ScanHooks } from './scanner.js';

export type RootOutcome = 'online' | 'offline' | 'probe_failed';

/** The device a path is on, by `lstat`. The seam's production implementation. */
async function deviceByLstat(absPath: string): Promise<bigint> {
  return (await lstat(absPath, { bigint: true })).dev;
}

/** The volume facts a previous scan recorded for a root, if it has any. */
function knownVolume(store: CatalogueStore, rootPath: string): KnownRoot | null {
  const known = store.rootVolumeByPath(rootPath);
  if (known === null) return null;
  return {
    volumeUuid: known.volumeUuid,
    fstype: known.fstype,
    // SQLite has no boolean; 1 is how a true is stored.
    isMountPoint: known.isMountPoint === null ? null : known.isMountPoint === 1,
  };
}

/** How a volume is named in a message: its uuid when it has one, else its type. */
function describeVolume(uuid: string | null, fstype: string | null): string {
  return uuid ?? fstype ?? 'unknown';
}

interface PendingDir {
  rootId: number;
  relPath: string;
  absPath: string;
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

function statusFor(name: string): ItemStatus {
  return INCOMPLETE_EXTENSIONS.has(extensionOf(name)) ? 'incomplete' : 'present';
}

/**
 * The head of a file, or the failure that stopped us reading it.
 *
 * A failure is returned rather than swallowed. The old version answered `null`
 * for every open error, which is indistinguishable from a file whose first
 * sixteen bytes really are empty — so an unreadable file was catalogued as an
 * ordinary empty one and the reason it was unreadable went nowhere.
 */
type HeadResult = { ok: true; head: Buffer } | { ok: false; code: string; message: string };

/** Reads at most `MAGIC_PREFIX_BYTES` from the head of a file. */
async function readHead(absPath: string): Promise<HeadResult> {
  let handle;
  try {
    handle = await openRegularFile(absPath);
  } catch (error) {
    return { ok: false, code: errorCode(error), message: messageOf(error) };
  }
  try {
    const buffer = Buffer.alloc(MAGIC_PREFIX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAGIC_PREFIX_BYTES, 0);
    return { ok: true, head: buffer.subarray(0, bytesRead) };
  } catch (error) {
    return { ok: false, code: errorCode(error), message: messageOf(error) };
  } finally {
    await handle.close();
  }
}

/**
 * Walks one root, recording directories and files, and returns its errors.
 * Returns the root's status: `offline` when a probe says the path is not there,
 * in which case nothing below was touched.
 */
export async function scanRoot(
  config: CatalogueConfig,
  store: CatalogueStore,
  rootPath: string,
  scanId: number,
  totals: ScanTotals,
  hooks: ScanHooks,
): Promise<'online' | 'offline' | 'probe_failed'> {
  const startedAt = new Date().toISOString();

  // Without a probe nothing is known about the volume, and the scan behaves
  // exactly as it did before volumes existed: every root is walked, nothing is
  // retired. The CLI supplies the real probe (Task 1b); tests supply a fake.
  const decision =
    hooks.volumeProbe === undefined
      ? null
      : decideRoot(rootPath, await hooks.volumeProbe(rootPath), knownVolume(store, rootPath));

  // Offline: the drive is not there, or its mount point has gone. It is recorded
  // and skipped without touching a single item — an absent drive is not a
  // deleted directory, and retiring its files would be the most destructive
  // thing this scan could do. Its volume facts are kept, so a different drive
  // turned up at the same path is still recognised as a different volume.
  if (decision?.kind === 'offline') {
    const offlineId = store.upsertRoot(rootPath, '0', '0', startedAt, scanId);
    store.markRootOffline(offlineId);
    store.recordScanRoot({ scanId, rootId: offlineId, path: rootPath, status: 'offline', fstype: null });
    store.setRootLastScan(offlineId, scanId);
    return 'offline';
  }

  // The probe could not answer. This is a fact about this machine, not about the
  // drive: `findmnt` may be missing, may have hit its deadline, or may have
  // printed something unreadable. Nothing about the root is known, so nothing
  // about it is changed — the root is *not* marked offline, because it has not
  // been shown to be absent, and its volume facts stay for the same reason.
  if (decision?.kind === 'probe_failed') {
    const probeId = store.upsertRoot(rootPath, '0', '0', startedAt, scanId);
    store.recordScanRoot({ scanId, rootId: probeId, path: rootPath, status: 'probe_failed', fstype: null });
    store.setRootLastScan(probeId, scanId);
    store.addErrors([
      {
        scanId,
        rootId: probeId,
        relPath: rootPath,
        code: 'PROBE_FAILED',
        message: `volume probe failed, root skipped and nothing touched: ${decision.reason}`,
      },
    ]);
    totals.errors += 1;
    return 'probe_failed';
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

  const volume = decision?.kind === 'scan' || decision?.kind === 'retired' ? decision.current : null;
  if (volume !== null) {
    if (decision?.kind === 'retired') {
      // A different volume is at this path: the drive was reformatted, or
      // another one was plugged in. Everything the old volume held is retired
      // with its hashes, because none of it can be trusted to still hash to
      // what was recorded, and the change is on the record for the root.
      const retired = store.retireRootItems(rootId);
      store.addErrors([
        {
          scanId,
          rootId,
          relPath: rootPath,
          code: 'VOLUME_CHANGED',
          message:
            `volume changed at this path: ${describeVolume(decision.previousUuid, decision.previousFstype)}` +
            ` became ${describeVolume(volume.uuid, volume.fstype)}; ${retired} item(s) retired`,
        },
      ]);
      totals.errors += 1;
    }
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
  /** Directories whose listing failed, so their items keep their previous state. */
  const unlistableRelPaths: string[] = [];
  const deviceOf = hooks.deviceOf ?? deviceByLstat;

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
      // Its rel_path is remembered so its items are not retired below: we never
      // saw inside it, which is not evidence that its contents are gone.
      errorBuffer.push({
        scanId,
        rootId,
        relPath: rel,
        code: errorCode(error),
        message: messageOf(error),
      });
      totals.errors += 1;
      unlistableRelPaths.push(rel);
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

    // Only filesystem failures are recorded here. A store failure must not be:
    // catching it would turn "the database could not be written" into one more
    // per-file error row and let the scan finish claiming totals it never stored.
    let dirStat;
    try {
      dirStat = await lstat(current.absPath, { bigint: true });
    } catch (error) {
      errorBuffer.push({
        scanId,
        rootId,
        relPath: rel,
        code: errorCode(error),
        message: messageOf(error),
      });
      totals.errors += 1;
      unlistableRelPaths.push(rel);
      continue;
    }

    const dirRow: DirRow = {
      rootId,
      relPath: rel,
      dev: dirStat.dev.toString(),
      ino: dirStat.ino.toString(),
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
      let childDev;
      try {
        childDev = await deviceOf(childAbs);
      } catch (error) {
        errorBuffer.push({ scanId, rootId, relPath: childRel, code: errorCode(error), message: messageOf(error) });
        totals.errors += 1;
        unlistableRelPaths.push(childRel);
        continue;
      }
      if (childDev !== rootDev) {
        // Spec §7.5: never cross a mount boundary below a root.
        errorBuffer.push({
          scanId,
          rootId,
          relPath: childRel,
          code: 'MOUNT_BOUNDARY',
          message: `device ${childDev} differs from root device ${rootDev}; not entered`,
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
      if (!head.ok) {
        // Recorded, and nothing recorded as an item: a file we could not read is
        // not a file with no contents.
        errorBuffer.push({ scanId, rootId, relPath: childRel, code: head.code, message: head.message });
        totals.errors += 1;
        continue;
      }
      itemBuffer.push({
        rootId,
        relPath: childRel,
        dirId,
        name,
        ext: extensionOf(name),
        kind: detectKind(name, head.head),
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
    }

    if (itemBuffer.length >= BATCH_ROWS || errorBuffer.length >= BATCH_ROWS) flush();
  }

  flush();
  // Only a root that was actually walked may retire its unseen items. The
  // offline path returns before reaching here, which is what stops an unplugged
  // drive from marking everything it holds as missing. Directories whose listing
  // failed are excluded too: we never saw inside them, so their items are not
  // evidence of anything and stay as they were.
  store.markMissingNotSeen(rootId, scanId, unlistableRelPaths);
  store.setRootLastScan(rootId, scanId);
  return 'online';
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

