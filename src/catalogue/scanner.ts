/**
 * The scan's lifecycle: one scan row, the walk, then the caller's pipeline
 * stages (spec §7.1, plan Task 1).
 *
 * The walk itself lives in `scan-root.ts`, because *where the scanner goes next*
 * and *when a scan counts as finished* are different questions. What is here is
 * the part that spans both: the row that stays open across every stage, and the
 * rule that it closes as `done` only when all of them have finished.
 *
 * Nothing in this module or the one it calls creates, moves, modifies or deletes
 * anything inside a root: files are opened read-only for at most 16 bytes.
 */
import { type CatalogueConfig } from './config.js';
import type { Listing } from './list-directory.js';
import { scanRoot } from './scan-root.js';
import type { OpenFile } from './scan-file.js';
import type { CatalogueStore, ScanTotals } from './store.js';
import type { VolumeProbe } from './volume.js';

/**
 * One stage of the scan pipeline, run after the walk and inside the same scan
 * row: hashing, bundle detection, metadata extraction.
 *
 * Stages run in order and the row stays `running` until the last one returns. A
 * stage that throws fails the scan and is named in `scans.failure_stage`.
 */
export interface ScanStage {
  /** Recorded as `failure_stage` if this stage throws. */
  name: string;
  run: (scanId: number) => Promise<unknown> | unknown;
}

export interface ScanResult {
  scanId: number;
  /** Number of roots scanned. */
  roots: number;
  /** Roots a probe found present and walked. */
  rootsOnline: number;
  /** Roots a probe reported missing: skipped, with no item touched. */
  rootsOffline: number;
  /** Roots a probe could not answer for: skipped, with no item touched. */
  rootsProbeFailed: number;
  totals: ScanTotals;
  elapsedMs: number;
  /** What each stage returned, keyed by stage name, for the caller to print. */
  stageResults: ReadonlyMap<string, unknown>;
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
// The volume types live in `volume.ts` (Task 1b) and are re-exported here
// because the scanner is what consumes them.
export type { VolumeInfo, VolumeProbe } from './volume.js';

export interface ScanHooks {
  onDirectory?: (dir: ScanDirectoryContext) => boolean | void;
  volumeProbe?: VolumeProbe;
  /**
   * Runs after the walk, inside this scan's row: hashing, bundles, metadata.
   */
  stages?: readonly ScanStage[];
  /**
   * The device number a path sits on. Injectable because proving `MOUNT_BOUNDARY`
   * needs a second filesystem, and a test may not mount one.
   */
  deviceOf?: (absPath: string) => Promise<bigint>;
  /**
   * Reads one directory's entries. Injectable because `chmod 000` does not deny
   * root, so permissions alone cannot make a directory unlistable in a test that
   * must also pass as root.
   */
  listDirectory?: (absPath: string, exclude: readonly string[]) => Promise<Listing>;
  /**
   * Opens one file read-only for the walk's head read. Injectable for the same
   * reason as `listDirectory`: a test needs a single file to fail with `EACCES`
   * even when it runs as root.
   */
  openFile?: OpenFile;
}

/**
 * Scans every configured root, then runs the caller's pipeline stages, all inside
 * one scan row. Read-only on the roots; the only writes are to the catalogue
 * database.
 *
 * The row is closed here rather than after the walk, because a scan is the whole
 * pipeline: its `finished_at` covers hashing, bundles and metadata too, and a
 * stage that throws leaves it `failed` naming the stage — never `done` with
 * figures it never computed.
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
    errors: 0,
    symlinksSeen: 0,
    bundlesSeen: 0,
    virtualenvsSkipped: 0,
  };
  const stageResults = new Map<string, unknown>();

  let rootsOnline = 0;
  let rootsOffline = 0;
  let rootsProbeFailed = 0;
  let failureStage: string | null = null;
  /** The stage running when an exception escapes, or null during the walk. */
  let lastStageStarted: string | null = null;
  try {
    for (const root of config.roots) {
      const status = await scanRoot(config, store, root, scanId, totals, hooks);
      if (status === 'online') rootsOnline += 1;
      else if (status === 'offline') rootsOffline += 1;
      else rootsProbeFailed += 1;
    }
    for (const stage of hooks.stages ?? []) {
      lastStageStarted = stage.name;
      stageResults.set(stage.name, await stage.run(scanId));
    }
    lastStageStarted = null;
  } catch (error) {
    // Whatever was running when the scan stopped: the walk, or a stage that had
    // begun. Re-thrown, because a failed scan is not a scan.
    failureStage = lastStageStarted ?? 'walk';
    store.finishScan(scanId, 'failed', new Date().toISOString(), totals, failureStage);
    throw error;
  }
  store.finishScan(scanId, 'done', new Date().toISOString(), totals, null);
  return {
    scanId,
    roots: config.roots.length,
    rootsOnline,
    rootsOffline,
    rootsProbeFailed,
    totals,
    elapsedMs: Date.now() - started,
    stageResults,
  };
}