/**
 * SQL for the tables that arrived after the first release of the catalogue
 * schema: `bundles` (plan Task 3) and `metadata` (plan Task 4).
 *
 * They live apart from `store.ts` so the core store — roots, scans, dirs,
 * items, errors, and the logic that decides what survives a scan — stays
 * readable, and because these two tables share a concern the core does not:
 * they point at rows another stage owns. Bundle detection decides *what* is a
 * bundle; metadata extraction decides *what is in* a file. Neither is storage
 * policy.
 *
 * Every function takes the connection rather than the store object, so these
 * stay pure SQL with no knowledge of how `openStore` is assembled.
 */
import type Database from 'better-sqlite3';
import type { BundleRow, MetadataRow } from './store.js';

/** Inserts or updates one bundle, returning its id. */
export function upsertBundle(db: Database.Database, row: BundleRow): number {
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
}

export function setItemsBundle(db: Database.Database, dirId: number, bundleId: number): number {
  return db.prepare('UPDATE items SET bundle_id = ? WHERE dir_id = ?').run(bundleId, dirId).changes;
}

/** Every non-missing item in a directory's whole subtree, whatever its bundle. */
export function subtreeItemStats(
  db: Database.Database,
  rootId: number,
  relPath: string,
): { files: number; bytes: number } {
  return db
    .prepare(
      `SELECT COUNT(*) AS files, COALESCE(SUM(i.size), 0) AS bytes
       FROM items i JOIN dirs d ON d.id = i.dir_id
       WHERE d.root_id = @rootId AND i.status <> 'missing'
         AND (d.rel_path = @relPath OR d.rel_path LIKE @prefix)`,
    )
    .get({ rootId, relPath, prefix: `${relPath}/%` }) as { files: number; bytes: number };
}

/** Claims only the items in a subtree that no other bundle has claimed. */
export function setItemsBundleInSubtree(
  db: Database.Database,
  rootId: number,
  relPath: string,
  bundleId: number,
): number {
  return db
    .prepare(
      `UPDATE items SET bundle_id = @bundleId
       WHERE bundle_id IS NULL AND status <> 'missing' AND dir_id IN (
         SELECT id FROM dirs
         WHERE root_id = @rootId AND (rel_path = @relPath OR rel_path LIKE @prefix))`,
    )
    .run({ rootId, relPath, prefix: `${relPath}/%`, bundleId }).changes;
}

/** Makes every bundle strictly inside a subtree a child of `bundleId`. */
export function setBundlesParentInSubtree(
  db: Database.Database,
  rootId: number,
  relPath: string,
  bundleId: number,
): number {
  return db
    .prepare(
      `UPDATE bundles SET parent_bundle_id = @bundleId
       WHERE id <> @bundleId AND root_id = @rootId
         AND rel_path LIKE @prefix AND (parent_bundle_id IS NULL OR parent_bundle_id = @bundleId)`,
    )
    .run({ rootId, prefix: `${relPath}/%`, bundleId }).changes;
}

export function setDirBundle(db: Database.Database, dirId: number, bundleId: number): void {
  db.prepare('UPDATE dirs SET bundle_id = ? WHERE id = ?').run(bundleId, dirId);
}

export function setBundleParent(db: Database.Database, bundleId: number, parentBundleId: number): void {
  db.prepare('UPDATE bundles SET parent_bundle_id = ? WHERE id = ?').run(parentBundleId, bundleId);
}

/** Writes one extractor result, replacing any earlier result for that pair. */
export function upsertMetadata(db: Database.Database, row: MetadataRow): void {
  db.prepare(
    `INSERT INTO metadata (item_id, extractor, extractor_version, status, fields_json, extracted_scan)
     VALUES (@itemId, @extractor, @extractorVersion, @status, @fieldsJson, @extractedScan)
     ON CONFLICT (item_id, extractor) DO UPDATE SET
       extractor_version = excluded.extractor_version, status = excluded.status,
       fields_json = excluded.fields_json, extracted_scan = excluded.extracted_scan`,
  ).run(row);
}