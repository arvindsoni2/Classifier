/**
 * Catalogue storage (plan Task 1). This module owns SQL and nothing else: the
 * scanner hands it plain rows and never touches the connection.
 *
 * The database lives in the data directory, never inside a scanned root, with
 * owner-only permissions. WAL, foreign keys and NORMAL synchronous mode are set
 * on every connection; `bundles` and `metadata` arrive in later tasks.
 */
import Database from 'better-sqlite3';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ScanStatus = 'running' | 'done' | 'failed';
export type ItemStatus = 'present' | 'missing' | 'incomplete';

export interface ScanTotals {
  filesSeen: number;
  dirsSeen: number;
  bytesSeen: number;
  filesHashed: number;
  errors: number;
  symlinksSeen: number;
  /**
   * Bundle directories that stopped the walk. In-process only: like
   * `symlinksSeen`, the `scans` table has no column for it (plan Task 3).
   */
  bundlesSeen: number;
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
}

/** What an upsert has to know to decide whether hashes survive the scan. */
interface ExistingItem {
  dev: string;
  ino: string;
  size: number;
  mtimeNs: string;
  id: number;
}

export interface CatalogueStore {
  readonly db: Database.Database;
  /** Absolute path of the SQLite file. */
  readonly path: string;
  startScan(startedAt: string): number;
  finishScan(scanId: number, status: ScanStatus, finishedAt: string, totals: ScanTotals): void;
  upsertRoot(path: string, dev: string, ino: string, addedAt: string, scanId: number): number;
  setRootLastScan(rootId: number, scanId: number): void;
  /** Inserts or updates one directory, returning its id. */
  upsertDir(row: DirRow): number;
  /**
   * Inserts or updates files. An item whose `(dev, ino, size, mtime_ns)` is
   * unchanged keeps its hashes; anything else invalidates them, because a
   * changed file can no longer be trusted to hash to its recorded value.
   */
  upsertItems(rows: ItemRow[]): void;
  /** Rows are never deleted: present items this scan did not see become missing. */
  markMissingNotSeen(rootId: number, scanId: number): number;
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
  /** Sets the directory's own bundle pointer. */
  setDirBundle(dirId: number, bundleId: number): void;
  /** Records that a bundle became a child of another bundle. */
  setBundleParent(bundleId: number, parentBundleId: number): void;
  close(): void;
}

const SCHEMA = new URL('./schema.sql', import.meta.url);

function applySchema(db: Database.Database): void {
  db.exec(readFileSync(SCHEMA, 'utf8'));
}

/** Restricts an existing file or directory to the owner (mode 0700/0600). */
function ownerOnly(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // A file that vanished between mkdir and chmod needs no permission fix.
  }
}

export function openStore(dataDir: string): CatalogueStore {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  ownerOnly(dataDir, 0o700);

  const path = join(dataDir, 'catalogue.sqlite');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  // Owner-only database and WAL sidecars: catalogue rows describe the user's
  // whole filesystem and must not be group- or world-readable.
  ownerOnly(path, 0o600);
  for (const suffix of ['-wal', '-shm']) ownerOnly(`${path}${suffix}`, 0o600);

  applySchema(db);

  const selectItem = db.prepare(
    // Aliased to camelCase so the caller compares the fields it names; a
    // mismatch here silently re-classifies every rescan as changed.
    'SELECT id, dev, ino, size, mtime_ns AS mtimeNs FROM items WHERE root_id = ? AND rel_path = ?',
  );
  const insertDir = db.prepare(
    `INSERT INTO dirs (root_id, rel_path, dev, ino, file_count, dir_count, last_seen_scan)
     VALUES (@rootId, @relPath, @dev, @ino, @fileCount, @dirCount, @lastSeenScan)
     ON CONFLICT (root_id, rel_path) DO UPDATE SET
       dev = excluded.dev, ino = excluded.ino, file_count = excluded.file_count,
       dir_count = excluded.dir_count, last_seen_scan = excluded.last_seen_scan`,
  );
  const insertItem = db.prepare(
    `INSERT INTO items (root_id, rel_path, dir_id, name, ext, kind, size, mtime_ns, dev, ino, nlink,
                        partial_hash, sha256, bundle_id, status, first_seen_scan, last_seen_scan)
     VALUES (@rootId, @relPath, @dirId, @name, @ext, @kind, @size, @mtimeNs, @dev, @ino, @nlink,
             NULL, NULL, NULL, @status, @scanId, @scanId)
     ON CONFLICT (root_id, rel_path) DO UPDATE SET
       dir_id = excluded.dir_id, name = excluded.name, ext = excluded.ext, kind = excluded.kind,
       size = excluded.size, mtime_ns = excluded.mtime_ns, dev = excluded.dev, ino = excluded.ino,
       nlink = excluded.nlink, status = excluded.status, last_seen_scan = excluded.last_seen_scan`,
  );
  const keepItem = db.prepare(
    `UPDATE items SET dir_id = @dirId, status = @status, last_seen_scan = @scanId
     WHERE id = @id`,
  );
  const dropHashes = db.prepare('UPDATE items SET partial_hash = NULL, sha256 = NULL, bundle_id = NULL WHERE id = ?');
  const markMissing = db.prepare(
    `UPDATE items SET status = 'missing' WHERE root_id = ? AND status <> 'missing' AND last_seen_scan <> ?`,
  );
  const insertError = db.prepare(
    'INSERT INTO scan_errors (scan_id, root_id, rel_path, code, message) VALUES (@scanId, @rootId, @relPath, @code, @message)',
  );

  return {
    db,
    path,

    startScan(startedAt) {
      const result = db.prepare('INSERT INTO scans (started_at, status) VALUES (?, ?)').run(startedAt, 'running');
      return Number(result.lastInsertRowid);
    },

    finishScan(scanId, status, finishedAt, totals) {
      db.prepare(
        `UPDATE scans SET finished_at = ?, status = ?, files_seen = ?, dirs_seen = ?,
                          bytes_seen = ?, files_hashed = ?, errors = ? WHERE id = ?`,
      ).run(
        finishedAt,
        status,
        totals.filesSeen,
        totals.dirsSeen,
        totals.bytesSeen,
        totals.filesHashed,
        totals.errors,
        scanId,
      );
    },

    upsertRoot(rootPath, dev, ino, addedAt, scanId) {
      db.prepare(
        `INSERT INTO roots (path, dev, ino, added_at, last_scan_id) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (path) DO UPDATE SET dev = excluded.dev, ino = excluded.ino`,
      ).run(rootPath, dev, ino, addedAt, scanId);
      const row = db.prepare('SELECT id FROM roots WHERE path = ?').get(rootPath) as { id: number };
      return row.id;
    },

    setRootLastScan(rootId, scanId) {
      db.prepare('UPDATE roots SET last_scan_id = ? WHERE id = ?').run(scanId, rootId);
    },

    upsertDir(row) {
      insertDir.run(row);
      const found = db.prepare('SELECT id FROM dirs WHERE root_id = ? AND rel_path = ?').get(row.rootId, row.relPath) as
        | { id: number }
        | undefined;
      if (found === undefined) throw new Error(`directory row vanished after insert: ${row.relPath}`);
      return found.id;
    },

    upsertItems(rows) {
      const write = db.transaction((batch: ItemRow[]) => {
        for (const row of batch) {
          const existing = selectItem.get(row.rootId, row.relPath) as ExistingItem | undefined;
          if (existing === undefined) {
            insertItem.run(row);
            continue;
          }
          const unchanged =
            existing.dev === row.dev &&
            existing.ino === row.ino &&
            existing.size === row.size &&
            existing.mtimeNs === row.mtimeNs;
          if (unchanged) {
            // Hashes (and, from Task 4, extracted metadata) survive untouched.
            keepItem.run({ id: existing.id, dirId: row.dirId, status: row.status, scanId: row.scanId });
            continue;
          }
          insertItem.run(row);
          dropHashes.run(existing.id);
        }
      });
      write(rows);
    },

    markMissingNotSeen(rootId, scanId) {
      return markMissing.run(rootId, scanId).changes;
    },

    addErrors(rows) {
      const write = db.transaction((batch: typeof rows) => {
        for (const row of batch) insertError.run(row);
      });
      write(rows);
    },

    setItemPartialHash(rootId, relPath, partialHash) {
      db.prepare('UPDATE items SET partial_hash = ? WHERE root_id = ? AND rel_path = ?').run(
        partialHash,
        rootId,
        relPath,
      );
    },

    setItemFullHash(rootId, relPath, sha256) {
      db.prepare('UPDATE items SET sha256 = ? WHERE root_id = ? AND rel_path = ?').run(sha256, rootId, relPath);
    },

    setFilesHashed(scanId, filesHashed) {
      db.prepare('UPDATE scans SET files_hashed = ? WHERE id = ?').run(filesHashed, scanId);
    },

    upsertBundle(row) {
      db.prepare(
        `INSERT INTO bundles (root_id, rel_path, type, parent_bundle_id, rule, member_count, total_size, detected_scan)
         VALUES (@rootId, @relPath, @type, @parentBundleId, @rule, @memberCount, @totalSize, @detectedScan)
         ON CONFLICT (root_id, rel_path) DO UPDATE SET
           type = excluded.type, parent_bundle_id = excluded.parent_bundle_id, rule = excluded.rule,
           member_count = excluded.member_count, total_size = excluded.total_size,
           detected_scan = excluded.detected_scan`,
      ).run(row);
      const found = db
        .prepare('SELECT id FROM bundles WHERE root_id = ? AND rel_path = ?')
        .get(row.rootId, row.relPath) as { id: number } | undefined;
      if (found === undefined) throw new Error(`bundle row vanished after insert: ${row.relPath}`);
      return found.id;
    },

    setItemsBundle(dirId, bundleId) {
      return db.prepare('UPDATE items SET bundle_id = ? WHERE dir_id = ?').run(bundleId, dirId).changes;
    },

    setDirBundle(dirId, bundleId) {
      db.prepare('UPDATE dirs SET bundle_id = ? WHERE id = ?').run(bundleId, dirId);
    },

    setBundleParent(bundleId, parentBundleId) {
      db.prepare('UPDATE bundles SET parent_bundle_id = ? WHERE id = ?').run(parentBundleId, bundleId);
    },

    close() {
      db.close();
    },
  };
}