/**
 * The shapes the catalogue stores, and the contract they are written through.
 *
 * Separated from `store.ts` so the declarations say what a row is while the
 * implementation says how it reaches SQLite. `store.ts` re-exports everything
 * here, so callers keep importing from one place.
 */
import type Database from 'better-sqlite3';

export type ScanStatus = 'running' | 'done' | 'failed';
export type ItemStatus = 'present' | 'missing' | 'incomplete';

export interface ScanTotals {
  filesSeen: number;
  dirsSeen: number;
  bytesSeen: number;
  errors: number;
  symlinksSeen: number;
  /**
   * Bundle directories that stopped the walk. In-process only: like
   * `symlinksSeen`, the `scans` table has no column for it (plan Task 3).
   */
  bundlesSeen: number;
  /**
   * Python virtualenvs skipped because their listing held `pyvenv.cfg`.
   * In-process only, for the same reason as `symlinksSeen`.
   */
  virtualenvsSkipped: number;
}

export interface DirRow {
  rootId: number;
  relPath: string;
  dev: string;
  ino: string;
  fileCount: number;
  dirCount: number;
  lastSeenScan: number;
}

export interface ItemRow {
  rootId: number;
  relPath: string;
  dirId: number;
  name: string;
  ext: string;
  kind: string;
  size: number;
  mtimeNs: string;
  dev: string;
  ino: string;
  nlink: number;
  status: ItemStatus;
  scanId: number;
}

export type BundleType =
  | 'code_repo'
  | 'code_project'
  | 'course'
  | 'album'
  | 'photo_set'
  | 'extracted_archive';

export interface BundleRow {
  rootId: number;
  relPath: string;
  type: BundleType;
  parentBundleId: number | null;
  rule: string;
  /** Null for the walk-stopping types: their contents were never catalogued. */
  memberCount: number | null;
  totalSize: number | null;
  detectedScan: number;
  /** The first and last scans that detected this bundle. */
  firstSeenScan: number;
  lastSeenScan: number;
}

export type MetadataStatus = 'ok' | 'unavailable' | 'failed' | 'timeout';

/** One extractor result for one item (plan Task 4). */
export interface MetadataRow {
  itemId: number;
  extractor: string;
  extractorVersion: string;
  status: MetadataStatus;
  fieldsJson: string;
  extractedScan: number;
}

/** How a root went in one scan: walked, absent, or its probe could not answer. */
export type ScanRootStatus = 'online' | 'offline' | 'probe_failed';

/** What a root's volume looks like right now (plan Task 1, D31). */
export interface RootVolume {
  status: 'online' | 'offline';
  volumeUuid: string | null;
  volumeLabel: string | null;
  fstype: string | null;
  mountPoint: string | null;
  isMountPoint: boolean | null;
  /** inode|path — whether file identity comes from inodes or from paths. */
  identityMode: 'inode' | 'path' | null;
  lastOnlineAt: string | null;
}

export interface CatalogueStore {
  readonly db: Database.Database;
  /** Absolute path of the SQLite file. */
  readonly path: string;
  startScan(startedAt: string): number;
  /**
   * Closes the scan row. `failureStage` names the part of the pipeline that
   * threw (`walk`, or a stage's own name), and is null for a scan that finished.
   */
  finishScan(
    scanId: number,
    status: ScanStatus,
    finishedAt: string,
    totals: ScanTotals,
    failureStage?: string | null,
  ): void;
  upsertRoot(path: string, dev: string, ino: string, addedAt: string, scanId: number): number;
  /** Records what a probe found about a root's volume, online or not. */
  setRootVolume(rootId: number, volume: RootVolume): void;
  /** Records that a scan covered this root, and how it went. */
  recordScanRoot(row: { scanId: number; rootId: number; path: string; status: ScanRootStatus; fstype: string | null }): void;
  /** What previous scans recorded about a root's volume, or null for a new one. */
  rootVolumeByPath(path: string): { volumeUuid: string | null; fstype: string | null; isMountPoint: number | null } | null;
  /** Marks a root offline, keeping its volume facts and `last_online_at`. */
  markRootOffline(rootId: number): void;
  /**
   * Retires every present item of a root whose volume changed, hashes and
   * extracted metadata included: none of it can be trusted to describe the bytes
   * now at that path. Rows are marked missing, never deleted.
   */
  retireRootItems(rootId: number): number;
  setRootLastScan(rootId: number, scanId: number): void;
  /** Inserts or updates one directory, returning its id. */
  upsertDir(row: DirRow): number;
  /**
   * Inserts or updates files. What counts as unchanged depends on the root's
   * recorded identity mode (see `identity.ts`): an unchanged file keeps its
   * hashes, and a file that moved within an inode-mode root keeps them too.
   * Anything else invalidates them, because changed bytes can no longer be
   * trusted to hash to what was recorded.
   */
  upsertItems(rows: ItemRow[]): void;
  /** Rows are never deleted: present items this scan did not see become missing. */
  /**
   * Retires items of `rootId` this scan did not see.
   *
   * Each path in `protectedRelPaths` and everything below it is left exactly as
   * it was: the walk failed to read something, which is not evidence that its
   * contents are gone. `''` means the root itself could not be listed, so nothing
   * under it is retired at all.
   */
  markMissingNotSeen(rootId: number, scanId: number, protectedRelPaths?: readonly string[]): number;
  addErrors(rows: { scanId: number; rootId: number; relPath: string; code: string; message: string }[]): void;
  /** Persists a candidate's partial hash; the full hash stays untouched. */
  setItemPartialHash(rootId: number, relPath: string, partialHash: string): void;
  /** Persists a candidate's full hash; the partial hash stays untouched. */
  setItemFullHash(rootId: number, relPath: string, sha256: string): void;
  /** Records how many distinct files this scan's hashing pass read. */
  setFilesHashed(scanId: number, filesHashed: number): void;
  /** Inserts or updates one bundle, returning its id. */
  upsertBundle(row: BundleRow): number;
  /** Points a directory's items at their bundle, returning how many rows moved. */
  setItemsBundle(dirId: number, bundleId: number): number;
  /**
   * Counts and sizes every non-missing item in a directory's whole subtree,
   * whatever bundle any of them belongs to. Used by `extracted_archive`, whose
   * unit is the extracted tree rather than one directory.
   */
  subtreeItemStats(rootId: number, relPath: string): { files: number; bytes: number };
  /**
   * Points at their bundle only those items in a subtree that no other bundle
   * has claimed, so a nested bundle keeps its own members.
   */
  setItemsBundleInSubtree(rootId: number, relPath: string, bundleId: number): number;
  /**
   * Records that every bundle strictly inside a subtree is a child of `bundleId`.
   * Used by `extracted_archive`; the archive itself is excluded.
   */
  setBundlesParentInSubtree(rootId: number, relPath: string, bundleId: number): number;
  /** Sets the directory's own bundle pointer. */
  setDirBundle(dirId: number, bundleId: number): void;
  /** Records that a bundle became a child of another bundle. */
  setBundleParent(bundleId: number, parentBundleId: number): void;
  /** Writes one extractor result, replacing any earlier result for that pair. */
  upsertMetadata(row: MetadataRow): void;
  close(): void;
}
