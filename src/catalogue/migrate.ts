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

export function migrateSchema(db: Database.Database): void {
  const present = new Set(
    (db.prepare('PRAGMA table_info(roots)').all() as { name: string }[]).map((column) => column.name),
  );
  for (const [name, type] of ADDED_ROOT_COLUMNS) {
    if (!present.has(name)) db.exec(`ALTER TABLE roots ADD COLUMN ${name} ${type}`);
  }
}