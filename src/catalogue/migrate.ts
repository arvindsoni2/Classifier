/**
 * Opening a catalogue that was created before the current schema (plan Task 1).
 *
 * `CREATE TABLE IF NOT EXISTS` creates a missing table but cannot widen one that
 * already exists. A catalogue created before volumes existed would therefore
 * open with the old `roots` shape, and every volume write would fail against it
 * with "no such column". So each column added since is applied with
 * `ALTER TABLE` when — and only when — it is absent.
 *
 * The migration is additive by design: existing rows keep their values and read
 * as null for the new facts until the next scan records them, and running it
 * again is a no-op. Nothing is dropped and nothing is rewritten, so opening a
 * catalogue can never lose history.
 */
import type Database from 'better-sqlite3';

/** Columns added after this schema's first shape: name and declaration. */
const ADDED_ROOT_COLUMNS: readonly (readonly [string, string])[] = [
  ['status', 'TEXT'],
  ['volume_uuid', 'TEXT'],
  ['volume_label', 'TEXT'],
  ['fstype', 'TEXT'],
  ['mount_point', 'TEXT'],
  ['is_mount_point', 'INTEGER'],
  ['identity_mode', 'TEXT'],
  ['last_online_at', 'TEXT'],
];

/** `scans` grew one column, for the same reason. */
const ADDED_SCAN_COLUMNS: readonly (readonly [string, string])[] = [['failure_stage', 'TEXT']];

/** `bundles` grew two scan-tracking columns, backfilled from `detected_scan`. */
const ADDED_BUNDLE_COLUMNS: readonly (readonly [string, string])[] = [
  ['first_seen_scan', 'INTEGER REFERENCES scans(id)'],
  ['last_seen_scan', 'INTEGER REFERENCES scans(id)'],
];

/** Applies `ALTER TABLE ... ADD COLUMN` for a table, skipping columns it has. */
function addMissingColumns(db: Database.Database, table: string, columns: readonly (readonly [string, string])[]): void {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name),
  );
  for (const [name, type] of columns) {
    if (!present.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

/**
 * Widens `scan_roots.status` to allow `probe_failed`.
 *
 * A `CHECK` constraint cannot be altered, so this is the one migration here that
 * rebuilds a table rather than adding a column. `scan_roots` has no foreign keys
 * pointing at it, so the copy is the whole of it and the operation is
 * transactional: either the old rows are all there under the new constraint, or
 * nothing changed.
 */
function widenScanRootsStatus(db: Database.Database): void {
  const supportsProbeFailed = db
    .prepare("SELECT COUNT(*) AS n FROM scan_roots WHERE status = 'probe_failed'")
    .get() as { n: number };
  if (supportsProbeFailed.n > 0) return;
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scan_roots'").get() as
    | { sql: string }
    | undefined)?.sql;
  // A pre-volume catalogue has no `scan_roots` table at all; nothing to widen.
  if (sql === undefined) return;
  if (sql.includes('probe_failed')) return;
  db.transaction(() => {
    db.exec(
      `CREATE TABLE scan_roots__widened (
         scan_id   INTEGER NOT NULL REFERENCES scans(id),
         root_id   INTEGER NOT NULL REFERENCES roots(id),
         path      TEXT    NOT NULL,
         status    TEXT    NOT NULL CHECK (status IN ('online', 'offline', 'probe_failed')),
         fstype    TEXT,
         PRIMARY KEY (scan_id, root_id)
       );
       INSERT INTO scan_roots__widened (scan_id, root_id, path, status, fstype)
         SELECT scan_id, root_id, path, status, fstype FROM scan_roots;
       DROP TABLE scan_roots;
       ALTER TABLE scan_roots__widened RENAME TO scan_roots;`,
    );
  })();
}

export function migrateSchema(db: Database.Database): void {
  addMissingColumns(db, 'roots', ADDED_ROOT_COLUMNS);
  addMissingColumns(db, 'scans', ADDED_SCAN_COLUMNS);
  addMissingColumns(db, 'bundles', ADDED_BUNDLE_COLUMNS);
  // Backfill bundle scan tracking from `detected_scan` for catalogues that predate
  // these columns, so historical reports keep the bundles they originally listed.
  const needsBackfill = db
    .prepare(
      'SELECT COUNT(*) AS n FROM bundles WHERE first_seen_scan IS NULL OR last_seen_scan IS NULL',
    )
    .get() as { n: number };
  if (needsBackfill.n > 0) {
    db.prepare(
      `UPDATE bundles SET
        first_seen_scan = COALESCE(first_seen_scan, detected_scan),
        last_seen_scan = COALESCE(last_seen_scan, detected_scan)`,
    ).run();
  }
  widenScanRootsStatus(db);
}