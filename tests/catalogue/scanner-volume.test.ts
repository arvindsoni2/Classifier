/**
 * Phase 1 Tasks 1a/1b: how the scanner treats volumes (plan
 * docs/11-Phase-1-Plan.md Task 1, spec D31).
 *
 * Split out of `scanner.test.ts`, which is about the walk. What is here is what a
 * root's filesystem changes: a probe reporting the volume, a root that has gone
 * offline, a mount point that no longer is one, a volume that changed identity,
 * and the cross-scan file identity that falls out of which filesystem it is.
 *
 * The probe is injected throughout, so every case runs on a machine with no
 * external drive attached. Synthetic fixture trees only (AGENTS.md rule 3).
 */
import Database from 'better-sqlite3';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/catalogue/config.js';
import { computeHashes } from '../../src/catalogue/dedupe.js';
import { scan } from '../../src/catalogue/scanner.js';
import { openStore } from '../../src/catalogue/store.js';
import { ext4Probe, probeWithOfflineRoots } from './fixtures.js';
import { configFor, fixture, items, storeFor } from './scanner-world.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('the scanner and volumes (Phase 1 Tasks 1a and 1b)', () => {  it('records what the probe says about each root volume', async () => {
    const fx = fixture(cleanups, 'volume-recorded', ['one/a.txt', 'one/b.txt']);
    const store = storeFor(cleanups, fx);
    const result = await scan(loadConfig(configFor(fx)), store, { volumeProbe: ext4Probe('abcd-1234') });

    const root = store.db.prepare('SELECT * FROM roots WHERE path = ?').get(fx.root) as Record<string, unknown>;
    expect(root.status).toBe('online');
    expect(root.volume_uuid).toBe('abcd-1234');
    expect(root.volume_label).toBe('fixture');
    expect(root.fstype).toBe('ext4');
    expect(root.mount_point).toBe(fx.root);
    expect(root.is_mount_point).toBe(1);
    // ext4 is an inode filesystem, so that is the identity the root records.
    expect(root.identity_mode).toBe('inode');
    expect(root.last_online_at).not.toBeNull();
    expect(result.rootsOnline).toBe(1);
    expect(result.rootsOffline).toBe(0);

    // The scan records which drives it covered, so a report can say so.
    const scanRoot = store.db
      .prepare('SELECT path, status, fstype FROM scan_roots WHERE scan_id = ?')
      .get(result.scanId) as { path: string; status: string; fstype: string };
    expect(scanRoot).toEqual({ path: fx.root, status: 'online', fstype: 'ext4' });
  });

it('a root the probe reports missing is offline, and nothing it holds changes', async () => {
    const fx = fixture(cleanups, 'volume-offline', ['present/one.txt', 'present/two.txt']);
    const store = storeFor(cleanups, fx);
    const gone = join(fx.root, 'unplugged');
    // Identical content, so the hashing pass gives them a full sha256 and the
    // "nothing changed" comparison below is about something real.
    fx.put('unplugged/one.txt', 'on the external drive\n');
    fx.put('unplugged/two.txt', 'on the external drive\n');
    const roots = [join(fx.root, 'present'), gone];

    // First scan: the drive is plugged in and its files are catalogued.
    const first = await scan(loadConfig(configFor(fx, { roots })), store, {
      volumeProbe: probeWithOfflineRoots([]),
    });
    await computeHashes(store, first.scanId);
    const before = store.db
      .prepare(
        'SELECT rel_path, status, sha256 FROM items WHERE root_id = (SELECT id FROM roots WHERE path = ?) ORDER BY rel_path',
      )
      .all(gone) as { rel_path: string; status: string; sha256: string | null }[];
    expect(before).toHaveLength(2);
    expect(before.every((row) => row.status === 'present' && row.sha256 !== null)).toBe(true);
    expect(first.rootsOnline).toBe(2);

    // The drive is unplugged: its mount point is an empty directory now.
    rmSync(gone, { recursive: true, force: true });
    mkdirSync(gone, { recursive: true });

    // Second scan: the drive is gone. Its items must not be marked missing.
    const second = await scan(loadConfig(configFor(fx, { roots })), store, {
      volumeProbe: probeWithOfflineRoots([gone]),
    });
    const after = store.db
      .prepare(
        'SELECT rel_path, status, sha256 FROM items WHERE root_id = (SELECT id FROM roots WHERE path = ?) ORDER BY rel_path',
      )
      .all(gone) as { rel_path: string; status: string; sha256: string | null }[];
    expect(after).toEqual(before);

    const rootRow = store.db.prepare('SELECT status FROM roots WHERE path = ?').get(gone) as { status: string };
    expect(rootRow.status).toBe('offline');
    expect(second.rootsOffline).toBe(1);
    expect(second.rootsOnline).toBe(1);
  });

it('a scan without a probe still walks the tree', async () => {
    // Task 1a adds the seam but does not wire the real findmnt probe, so the CLI
    // path is unchanged: no probe means no volume facts, and a normal scan.
    const fx = fixture(cleanups, 'volume-no-probe', ['a.txt', 'sub/b.txt']);
    const store = storeFor(cleanups, fx);
    const result = await scan(loadConfig(configFor(fx)), store);

    expect(items(store).map((row) => row.rel_path)).toEqual(['a.txt', 'sub/b.txt']);
    const root = store.db.prepare('SELECT status, volume_uuid, identity_mode FROM roots').get() as Record<
      string,
      unknown
    >;
    expect(root.status).toBeNull();
    expect(root.volume_uuid).toBeNull();
    expect(root.identity_mode).toBeNull();
    // "Online" here means "walked". Without a probe nothing knows what
    // filesystem the root is on, so no volume facts are recorded — but the walk
    // happened, and Task 1b is what supplies the real probe.
    expect(result.rootsOnline).toBe(1);
    expect(result.rootsOffline).toBe(0);
  });

it('a missing root is not a configuration error', async () => {
    const fx = fixture(cleanups, 'config-missing-root', ['a.txt']);
    const missing = join(fx.parent, 'drive-not-plugged-in');

    // A drive that is not plugged in must not stop the whole scan.
    const loaded = loadConfig(configFor(fx, { roots: [fx.root, missing] }));
    expect(loaded.roots).toEqual([fx.root, missing]);

    // A path that exists but is a file is still a mistake worth reporting.
    const notADirectory = join(fx.parent, 'a-file.txt');
    writeFileSync(notADirectory, 'a file, not a root\n', 'utf8');
    expect(() => loadConfig(configFor(fx, { roots: [notADirectory] }))).toThrow(/not a directory/i);
    // Relative paths and nesting are still refused.
    expect(() => loadConfig(configFor(fx, { roots: ['relative/path'] }))).toThrow(/absolute/i);
    expect(() => loadConfig(configFor(fx, { roots: [fx.root, fx.dir('sub')] }))).toThrow(/inside another root/i);
  });

it('an existing database gains the volume columns without losing anything', async () => {
    // The catalogue on a real machine was created before volumes existed.
    // CREATE TABLE IF NOT EXISTS cannot add columns, so opening it must migrate.
    const parent = mkdtempSync(join(tmpdir(), 'catalogue-old-db-'));
    cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
    const legacy = new Database(join(parent, 'catalogue.sqlite'));
    legacy.exec(`CREATE TABLE roots (
        id INTEGER PRIMARY KEY, path TEXT UNIQUE, dev TEXT NOT NULL, ino TEXT NOT NULL,
        added_at TEXT NOT NULL, last_scan_id INTEGER)`);
    legacy
      .prepare('INSERT INTO roots (id, path, dev, ino, added_at) VALUES (1, ?, ?, ?, ?)')
      .run('/media/old/drive', '2049:2', '700', '2026-01-01T00:00:00.000Z');
    legacy.close();

    const store = openStore(parent);
    cleanups.push(() => store.close());

    const columns = new Set(
      (store.db.prepare('PRAGMA table_info(roots)').all() as { name: string }[]).map((row) => row.name),
    );
    for (const column of [
      'status',
      'volume_uuid',
      'volume_label',
      'fstype',
      'mount_point',
      'is_mount_point',
      'identity_mode',
      'last_online_at',
    ]) {
      expect(columns.has(column), `migration added roots.${column}`).toBe(true);
    }
    // The existing root survives, with its history intact.
    const root = store.db.prepare('SELECT * FROM roots WHERE id = 1').get() as Record<string, unknown>;
    expect(root.path).toBe('/media/old/drive');
    expect(root.added_at).toBe('2026-01-01T00:00:00.000Z');
    expect(root.status).toBeNull();
    // Opening the same database twice is not an error.
    const reopened = openStore(parent);
    expect(reopened.db.prepare('SELECT COUNT(*) AS n FROM roots').get()).toEqual({ n: 1 });
    reopened.close();
  });

it('a changed device number alone does not invalidate a file', async () => {
    // A USB drive gets a new device number every time it is plugged in, so `dev`
    // must not be part of the cross-scan identity. Driven at the store, because
    // that is where the comparison lives and no fixture can renumber an inode.
    const fx = fixture(cleanups, 'device-churn', ['stable.txt', 'sub/nested.txt']);
    const store = storeFor(cleanups, fx);
    const result = await scan(loadConfig(configFor(fx)), store, { volumeProbe: ext4Probe() });

    const rootId = (store.db.prepare('SELECT id FROM roots').get() as { id: number }).id;
    const rows = store.db
      .prepare("SELECT id, rel_path, dir_id, ino FROM items WHERE last_seen_scan = (SELECT MAX(id) FROM scans) ORDER BY rel_path")
      .all() as { id: number; rel_path: string; dir_id: number; ino: string }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      store.db.prepare('UPDATE items SET sha256 = ? WHERE id = ?').run(`hash-of-${row.rel_path}`, row.id);
    }

    // The same files, same inode, same size and mtime, new device number.
    store.upsertItems(
      rows.map((row) => {
        const stat = statSync(join(fx.root, row.rel_path), { bigint: true });
        return {
          rootId,
          relPath: row.rel_path,
          dirId: row.dir_id,
          name: row.rel_path,
          ext: 'txt',
          kind: 'document',
          size: Number(stat.size),
          mtimeNs: stat.mtimeNs.toString(),
          dev: '9999:1',
          ino: row.ino,
          nlink: Number(stat.nlink),
          status: 'present' as const,
          scanId: result.scanId,
        };
      }),
    );

    const after = store.db.prepare('SELECT rel_path, sha256 FROM items ORDER BY rel_path').all() as {
      rel_path: string;
      sha256: string;
    }[];
    expect(after.map((row) => row.sha256)).toEqual(['hash-of-stable.txt', 'hash-of-sub/nested.txt']);
  });

it('records errors and continues', async () => {
    if (process.getuid?.() === 0) {
      // chmod 000 does not deny root, so the fixture could not prove anything.
      console.warn('skipping records_errors_and_continues: running as root');
      return;
    }
    const fx = fixture(cleanups, 'errors', ['readable/one.txt', 'readable/two.txt']);
    const blocked = fx.dir('blocked');
    writeFileSync(join(blocked, 'hidden.txt'), 'unreadable\n');
    chmodSync(blocked, 0o000);
    cleanups.push(() => chmodSync(blocked, 0o755));

    const store = storeFor(cleanups, fx);
    const result = await scan(loadConfig(configFor(fx)), store);

    const errors = store.db.prepare('SELECT rel_path, code FROM scan_errors').all() as {
      rel_path: string;
      code: string;
    }[];
    expect(errors).toHaveLength(1);
    expect(errors[0]?.rel_path).toBe('blocked');
    expect(errors[0]?.code).toBe('EACCES');
    expect(result.totals.errors).toBe(1);
    // The rest of the scan still completed.
    expect(items(store).map((row) => row.rel_path)).toEqual(['readable/one.txt', 'readable/two.txt']);
    expect(result.scanId).toBeGreaterThan(0);
  });

});
