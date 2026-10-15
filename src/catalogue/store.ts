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
import { isUnchanged, type IdentityMode } from './identity.js';
import { migrateSchema } from './migrate.js';
import type { CatalogueStore, ItemRow } from './store-types.js';
import {
  setBundleParent,
  setBundlesParentInSubtree,
  setDirBundle,
  setItemsBundle,
  setItemsBundleInSubtree,
  subtreeItemStats,
  upsertBundle,
  upsertMetadata,
} from './store-extras.js';

export type {
  BundleRow,
  BundleType,
  CatalogueStore,
  DirRow,
  ItemRow,
  ItemStatus,
  MetadataRow,
  MetadataStatus,
  RootVolume,
  ScanStatus,
  ScanTotals,
} from './store-types.js';

/** What an upsert has to know to decide whether hashes survive the scan. */
interface ExistingItem {
  ino: string;
  size: number;
  mtimeNs: string;
  id: number;
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
  migrateSchema(db);

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
  // A changed file's extracted metadata describes bytes that no longer exist, so
  // it goes with the hashes. Rows are deleted only from the catalogue.
  const dropMetadata = db.prepare('DELETE FROM metadata WHERE item_id = ?');
  const markMissingBase = `UPDATE items SET status = 'missing'
       WHERE root_id = @rootId AND status <> 'missing' AND last_seen_scan <> @scanId`;
  const markMissing = db.prepare(markMissingBase);
  const selectRootVolume = db.prepare(
    'SELECT volume_uuid AS volumeUuid, fstype, is_mount_point AS isMountPoint FROM roots WHERE path = ?',
  );
  const selectIdentityMode = db.prepare('SELECT identity_mode AS identityMode FROM roots WHERE id = ?');
  // The identity of a file that moved: same inode, size and mtime, a different
  // path, and hashes already recorded. Only inode-mode roots look here, and
  // items_by_identity keeps it a lookup rather than a scan.
  const selectMovedHashes = db.prepare(
    `SELECT id, partial_hash AS partialHash, sha256 FROM items
     WHERE root_id = @rootId AND ino = @ino AND size = @size AND mtime_ns = @mtimeNs
       AND rel_path <> @relPath AND (sha256 IS NOT NULL OR partial_hash IS NOT NULL)
     ORDER BY last_seen_scan DESC LIMIT 1`,
  );
  const applyHashes = db.prepare(
    'UPDATE items SET partial_hash = @partialHash, sha256 = @sha256 WHERE id = @id',
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

    finishScan(scanId, status, finishedAt, totals, failureStage: string | null = null) {
      // `files_hashed` is deliberately absent: the walk never counts hashes, and
      // the hash stage is the only thing that can — it owns the column through
      // `setFilesHashed`. Writing it here would overwrite the stage's figure
      // with the walk's zero, which is what the scan row used to record.
      db.prepare(
        `UPDATE scans SET finished_at = ?, status = ?, failure_stage = ?, files_seen = ?, dirs_seen = ?,
                          bytes_seen = ?, errors = ? WHERE id = ?`,
      ).run(
        finishedAt,
        status,
        failureStage,
        totals.filesSeen,
        totals.dirsSeen,
        totals.bytesSeen,
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

    setRootVolume(rootId, volume) {
      db.prepare(
        `UPDATE roots SET status = @status, volume_uuid = @volumeUuid, volume_label = @volumeLabel,
                          fstype = @fstype, mount_point = @mountPoint, is_mount_point = @isMountPoint,
                          identity_mode = @identityMode, last_online_at = @lastOnlineAt
         WHERE id = @rootId`,
      ).run({
        rootId,
        ...volume,
        isMountPoint: volume.isMountPoint === null ? null : Number(volume.isMountPoint),
      });
    },

    rootVolumeByPath(rootPath) {
      return (selectRootVolume.get(rootPath) as
        | { volumeUuid: string | null; fstype: string | null; isMountPoint: number | null }
        | undefined) ?? null;
    },

    markRootOffline(rootId) {
      // Only the status changes. The volume facts stay, and `last_online_at`
      // keeps pointing at the last time this drive was actually readable: that
      // is when the question "is a different drive at this path?" can next be
      // answered.
      db.prepare("UPDATE roots SET status = 'offline' WHERE id = ?").run(rootId);
    },

    retireRootItems(rootId) {
      return db.transaction(() => {
        db.prepare(
          `DELETE FROM metadata WHERE item_id IN
             (SELECT id FROM items WHERE root_id = ? AND status = 'present')`,
        ).run(rootId);
        return db
          .prepare(
            `UPDATE items SET status = 'missing', partial_hash = NULL, sha256 = NULL, bundle_id = NULL
             WHERE root_id = ? AND status = 'present'`,
          )
          .run(rootId).changes;
      })();
    },

    recordScanRoot(row) {
      db.prepare(
        `INSERT INTO scan_roots (scan_id, root_id, path, status, fstype)
         VALUES (@scanId, @rootId, @path, @status, @fstype)
         ON CONFLICT (scan_id, root_id) DO UPDATE SET
           path = excluded.path, status = excluded.status, fstype = excluded.fstype`,
      ).run(row);
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
      // Identity mode is a property of the root's volume, so it is read once per
      // root per batch rather than per row.
      const modes = new Map<number, IdentityMode>();
      const modeOf = (rootId: number): IdentityMode => {
        const cached = modes.get(rootId);
        if (cached !== undefined) return cached;
        const row = selectIdentityMode.get(rootId) as { identityMode: string | null } | undefined;
        // No recorded mode means a root catalogued before volumes existed:
        // inode identity is the behaviour every root had.
        const mode: IdentityMode = row?.identityMode === 'path' ? 'path' : 'inode';
        modes.set(rootId, mode);
        return mode;
      };
      const write = db.transaction((batch: ItemRow[]) => {
        for (const row of batch) {
          const mode = modeOf(row.rootId);
          const existing = selectItem.get(row.rootId, row.relPath) as ExistingItem | undefined;
          if (existing === undefined) {
            insertItem.run(row);
            // A file that was renamed is not a new file: on an inode filesystem
            // its identity travels with it, so its hashes travel too rather than
            // the next pass re-reading a file the catalogue already knows.
            if (mode === 'inode') {
              const moved = selectMovedHashes.get({
                rootId: row.rootId,
                ino: row.ino,
                size: row.size,
                mtimeNs: row.mtimeNs,
                relPath: row.relPath,
              }) as { id: number; partialHash: string | null; sha256: string | null } | undefined;
              if (moved !== undefined) {
                const inserted = db
                  .prepare('SELECT id FROM items WHERE root_id = ? AND rel_path = ?')
                  .get(row.rootId, row.relPath) as { id: number };
                applyHashes.run({
                  id: inserted.id,
                  partialHash: moved.partialHash,
                  sha256: moved.sha256,
                });
              }
            }
            continue;
          }
          if (isUnchanged(mode, { ...existing, relPath: row.relPath, size: existing.size, mtimeNs: existing.mtimeNs }, row)) {
            // Hashes (and, from Task 4, extracted metadata) survive untouched.
            keepItem.run({ id: existing.id, dirId: row.dirId, status: row.status, scanId: row.scanId });
            continue;
          }
          insertItem.run(row);
          dropHashes.run(existing.id);
          dropMetadata.run(existing.id);
        }
      });
      write(rows);
    },

    markMissingNotSeen(rootId, scanId, protectedRelPaths = []) {
      if (protectedRelPaths.length === 0) return markMissing.run({ rootId, scanId }).changes;

      // A protected path keeps its own row and its whole subtree: a scan that
      // could not read something has learned nothing about what is under it, and
      // marking those rows `missing` is how one `EACCES` used to look exactly
      // like a deletion.
      //
      // `''` is the root itself. If its listing failed, the walk saw nothing at
      // all, so it has no standing to retire any item of this root.
      if (protectedRelPaths.includes('')) return 0;
      // Matched by prefix over `items.rel_path` rather than by collecting the
      // directory ids inside each protected subtree. One unreadable directory
      // with thousands of subdirectories is therefore one parameter, not
      // thousands, so a large protected subtree cannot exceed SQLite's variable
      // limit. `json_each` turns the list into rows, so the statement is built
      // once.
      return db
        .prepare(
          `${markMissingBase}
           AND NOT EXISTS (
             SELECT 1 FROM json_each(@protected) AS p
             WHERE items.rel_path = p.value
                OR substr(items.rel_path, 1, length(p.value) + 1) = p.value || '/'
           )`,
        )
        .run({ rootId, scanId, protected: JSON.stringify(protectedRelPaths) }).changes;
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
      return upsertBundle(db, row);
    },

    setItemsBundle(dirId, bundleId) {
      return setItemsBundle(db, dirId, bundleId);
    },

    subtreeItemStats(rootId, relPath) {
      return subtreeItemStats(db, rootId, relPath);
    },

    setItemsBundleInSubtree(rootId, relPath, bundleId) {
      return setItemsBundleInSubtree(db, rootId, relPath, bundleId);
    },

    setBundlesParentInSubtree(rootId, relPath, bundleId) {
      return setBundlesParentInSubtree(db, rootId, relPath, bundleId);
    },

    setDirBundle(dirId, bundleId) {
      setDirBundle(db, dirId, bundleId);
    },

    setBundleParent(bundleId, parentBundleId) {
      setBundleParent(db, bundleId, parentBundleId);
    },

    upsertMetadata(row) {
      upsertMetadata(db, row);
    },

    close() {
      db.close();
    },
  };
}