/**
 * Phase 1 Task 1: read-only recursive scanner, config and store.
 *
 * Spec docs/10-Catalogue-First-Spec.md §5 Phase 1 and plan docs/11-Phase-1-Plan.md
 * Task 1. Every test uses a synthetic fixture tree (AGENTS.md rule 3) and
 * asserts observable invariants of the catalogue, never internals.
 */
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/catalogue/config.js';
import { computeHashes } from '../../src/catalogue/dedupe.js';
import { scan } from '../../src/catalogue/scanner.js';
import { openStore, type CatalogueStore } from '../../src/catalogue/store.js';
import { ext4Probe, makeTree, pdfBytes, probeWithOfflineRoots, type Fixture } from './fixtures.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function fixture(label: string, entries: string[]): Fixture {
  const made = makeTree(label, entries);
  cleanups.push(made.cleanup);
  return made;
}

function track<T>(value: T): T {
  cleanups.push(() => {
    if (typeof value === 'object' && value !== null && 'close' in value) {
      (value as { close(): void }).close();
    }
  });
  return value;
}

/** Opens a store in the fixture's parent so no data lands inside the root. */
function storeFor(fx: Fixture): CatalogueStore {
  const store = track(openStore(join(fx.parent, 'data')));
  return store;
}

interface ItemRow {
  rel_path: string;
  kind: string;
  size: number;
  status: string;
}

function items(store: CatalogueStore): ItemRow[] {
  return store.db
    .prepare('SELECT rel_path, kind, size, status FROM items ORDER BY rel_path')
    .all() as ItemRow[];
}

function itemByName(store: CatalogueStore, name: string): ItemRow | undefined {
  return items(store).find((row) => row.rel_path === name || row.rel_path.endsWith(`/${name}`));
}

function configFor(fx: Fixture, overrides: Record<string, unknown> = {}): string {
  const path = join(fx.parent, 'catalogue.json');
  writeFileSync(
    path,
    JSON.stringify({
      roots: [fx.root],
      exclude: ['node_modules', '__pycache__', '.venv', 'venv', '.tox', '.cache', '.Trash-*'],
      dataDir: join(fx.parent, 'data'),
      ...overrides,
    }),
    'utf8',
  );
  return path;
}

describe('catalogue scanner (Phase 1 Task 1)', () => {
  it('catalogues nested files with kinds', async () => {
    const fx = fixture('nested', [
      'top.txt',
      'one/two/three/report.pdf',
      'one/two/three/song.mp3',
      'one/deep/nested/notes.md',
    ]);
    const store = storeFor(fx);
    const result = await scan(loadConfig(configFor(fx)), store);

    expect(result.totals.filesSeen).toBe(4);
    const byPath = new Map(items(store).map((row) => [row.rel_path, row]));
    const pdf = byPath.get('one/two/three/report.pdf');
    expect(pdf, 'three-level-deep file is catalogued with its relative path').toBeDefined();
    expect(pdf?.kind).toBe('document');
    // The recorded size is the file's real size, not a rounded or stale one.
    expect(pdf?.size).toBe(statSync(join(fx.root, 'one/two/three/report.pdf')).size);
    expect(byPath.get('one/two/three/song.mp3')?.kind).toBe('audio');
    expect(byPath.get('one/deep/nested/notes.md')?.kind).toBe('document');
    expect(byPath.get('top.txt')?.status).toBe('present');
    // The scan finishes and is recorded as done, not left running.
    const scanRow = store.db.prepare('SELECT status, dirs_seen FROM scans WHERE id = ?').get(result.scanId) as {
      status: string;
      dirs_seen: number;
    };
    expect(scanRow.status).toBe('done');
    expect(scanRow.dirs_seen).toBeGreaterThan(0);
  });

  it('does not follow symlinks or enter excluded dirs', async () => {
    const fx = fixture('symlink-exclude', [
      'real/file.txt',
      'node_modules/pkg/index.js',
      '.venv/lib/module.py',
      '__pycache__/thing.pyc',
    ]);
    const outside = join(fx.parent, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'outside the root, must not be catalogued\n');
    writeFileSync(join(fx.parent, 'outside-secret.txt'), 'must not be catalogued\n');
    // A directory symlink pointing at a real directory outside the root, and a
    // file symlink. The directory has to exist: a dangling link proves nothing,
    // because a scanner that followed it would find no files to catalog.
    symlinkSync(outside, join(fx.root, 'escape'));
    symlinkSync(join(fx.parent, 'outside-secret.txt'), join(fx.root, 'escape.txt'));
    const store = storeFor(fx);
    const result = await scan(loadConfig(configFor(fx)), store);

    const catalogued = items(store).map((row) => row.rel_path);
    expect(catalogued).toContain('real/file.txt');
    expect(catalogued.filter((path) => path.startsWith('node_modules'))).toEqual([]);
    expect(catalogued.filter((path) => path.startsWith('.venv'))).toEqual([]);
    expect(catalogued.filter((path) => path.startsWith('__pycache__'))).toEqual([]);
    // Symlinks are never followed and never become items of their own.
    expect(catalogued).not.toContain('escape');
    expect(catalogued).not.toContain('escape.txt');
    expect(catalogued.some((path) => path.includes('outside-secret'))).toBe(false);
    // Nothing inside the linked directory was catalogued under it, and the file
    // that really lives there was not catalogued at all.
    expect(catalogued.filter((path) => path.startsWith('escape/'))).toEqual([]);
    expect(catalogued.some((path) => path.includes('secret.txt'))).toBe(false);
    // They are still counted, so the totals stay honest.
    expect(result.totals.symlinksSeen).toBe(2);
  });

  it('does not enter Python virtualenvs, whatever they are named', async () => {
    // A virtualenv is identified by its contents, not its name: `venv` and
    // `.venv` are in the exclude list, but nobody names their envs that way.
    const fx = fixture('virtualenv', [
      'envs/torch_env/pyvenv.cfg',
      'envs/torch_env/lib/python3.12/site-packages/torch/include/header.h',
      'envs/torch_env/lib/python3.12/site-packages/pkg.py',
      'envs/myenv/pyvenv.cfg',
      'envs/myenv/bin/python',
      'envs/myenv/lib/site-packages/thing.py',
      'work/notes.txt',
      'work/data/values.csv',
    ]);
    const store = storeFor(fx);
    const result = await scan(loadConfig(configFor(fx)), store);

    // Nothing inside either virtualenv is catalogued, at any depth.
    const catalogued = items(store).map((row) => row.rel_path);
    expect(catalogued.filter((path) => path.startsWith('envs/'))).toEqual([]);
    expect(catalogued.some((path) => path.includes('torch'))).toBe(false);
    expect(catalogued.some((path) => path.includes('site-packages'))).toBe(false);
    // The rest of the tree is scanned as normal.
    expect(catalogued).toEqual(['work/data/values.csv', 'work/notes.txt']);
    // A skipped virtualenv is not even recorded as a directory, exactly like a
    // name matched by `exclude`.
    const dirs = store.db.prepare('SELECT rel_path FROM dirs ORDER BY rel_path').all() as { rel_path: string }[];
    expect(dirs.map((row) => row.rel_path)).toEqual(['', 'envs', 'work', 'work/data']);
    expect(result.totals.filesSeen).toBe(2);
  });

  it('still scans a root that is itself a virtualenv', async () => {
    // The root is exempt: skipping it would catalogue nothing at all, and the
    // data directory is never inside a root anyway.
    const fx = fixture('virtualenv-root', ['pyvenv.cfg', 'lib/site-packages/thing.py']);
    const store = storeFor(fx);
    const result = await scan(loadConfig(configFor(fx)), store);

    const catalogued = items(store).map((row) => row.rel_path);
    expect(catalogued).toContain('lib/site-packages/thing.py');
    expect(catalogued).toContain('pyvenv.cfg');
    expect(result.totals.filesSeen).toBe(2);
  });

  it('a nested virtualenv does not hide its siblings', async () => {
    // The skip is per directory; it is not inherited by the parent.
    const fx = fixture('virtualenv-nested', [
      'project/venv/pyvenv.cfg',
      'project/venv/lib/x.py',
      'project/src/main.py',
      'project/README.md',
    ]);
    const store = storeFor(fx);
    await scan(loadConfig(configFor(fx)), store);

    expect(items(store).map((row) => row.rel_path)).toEqual(['project/README.md', 'project/src/main.py']);
  });

  it('records what the probe says about each root volume', async () => {
    const fx = fixture('volume-recorded', ['one/a.txt', 'one/b.txt']);
    const store = storeFor(fx);
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
    const fx = fixture('volume-offline', ['present/one.txt', 'present/two.txt']);
    const store = storeFor(fx);
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
    const fx = fixture('volume-no-probe', ['a.txt', 'sub/b.txt']);
    const store = storeFor(fx);
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
    const fx = fixture('config-missing-root', ['a.txt']);
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
    const fx = fixture('device-churn', ['stable.txt', 'sub/nested.txt']);
    const store = storeFor(fx);
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
    const fx = fixture('errors', ['readable/one.txt', 'readable/two.txt']);
    const blocked = fx.dir('blocked');
    writeFileSync(join(blocked, 'hidden.txt'), 'unreadable\n');
    chmodSync(blocked, 0o000);
    cleanups.push(() => chmodSync(blocked, 0o755));

    const store = storeFor(fx);
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

  it('marks incomplete and missing', async () => {
    const fx = fixture('incomplete-missing', ['stable.txt', 'partial.crdownload', 'temp.tmp', 'soon-gone.txt']);
    const config = loadConfig(configFor(fx));
    const store = storeFor(fx);

    await scan(config, store);
    expect(itemByName(store, 'partial.crdownload')?.status).toBe('incomplete');
    expect(itemByName(store, 'temp.tmp')?.status).toBe('incomplete');
    expect(itemByName(store, 'stable.txt')?.status).toBe('present');

    rmSync(join(fx.root, 'soon-gone.txt'), { force: true });
    const second = await scan(config, store);

    const gone = itemByName(store, 'soon-gone.txt');
    expect(gone?.status).toBe('missing');
    // Rows are never deleted, so the vanished file keeps its row and identity.
    expect(gone?.size).toBe('fixture soon-gone.txt\n'.length);
    expect(itemByName(store, 'stable.txt')?.status).toBe('present');
    expect(second.scanId).toBeGreaterThan(0);
  });

  it('kind from magic bytes', async () => {
    const fx = fixture('magic', [
      'report.bin', // actually a PDF: magic must beat the extension
      'photo.dat', // PNG magic
      'plain.dat', // no magic at all
    ]);
    fx.put('report.bin', pdfBytes('magic wins over a misleading extension'));
    fx.put('photo.dat', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]));
    fx.put('plain.dat', 'just words, no magic\n');
    const store = storeFor(fx);
    await scan(loadConfig(configFor(fx)), store);

    expect(itemByName(store, 'report.bin')?.kind).toBe('document');
    expect(itemByName(store, 'photo.dat')?.kind).toBe('image');
    expect(itemByName(store, 'plain.dat')?.kind).toBe('other');
  });

  it('scan is read only', async () => {
    const fx = fixture('readonly', ['a.txt', 'sub/b.txt', 'sub/c.pdf', 'sub/deep/d.txt']);
    const before = snapshot(fx.root);
    const store = storeFor(fx);
    await scan(loadConfig(configFor(fx)), store);
    const after = snapshot(fx.root);

    expect(after).toEqual(before);
    // The store lives outside the root; nothing was written inside it.
    expect(existsSync(join(fx.root, 'catalogue.sqlite'))).toBe(false);
    expect(readdirSync(fx.root).sort()).toEqual(['a.txt', 'sub']);
  });

  it('config rejects nested roots and data dir inside root', () => {
    const fx = fixture('config', ['a.txt']);
    const inner = fx.dir('inner');
    const dataInsideRoot = join(fx.root, 'data');
    const notADirectory = join(fx.parent, 'not-a-directory.txt');
    writeFileSync(notADirectory, 'a file, not a root\n', 'utf8');

    expect(() => loadConfig(configFor(fx, { roots: [fx.root, inner] }))).toThrow(ConfigError);
    expect(() => loadConfig(configFor(fx, { roots: [fx.root, inner] }))).toThrow(/inside another root/i);
    expect(() => loadConfig(configFor(fx, { dataDir: dataInsideRoot }))).toThrow(/dataDir/i);
    expect(() => loadConfig(configFor(fx, { roots: ['relative/path'] }))).toThrow(/absolute/i);
    expect(() => loadConfig(configFor(fx, { roots: [notADirectory] }))).toThrow(/not a directory/i);
    // A root that does not exist is no longer an error: it is an unplugged
    // drive, which the scan reports as offline. Covered above.
    expect(loadConfig(configFor(fx, { roots: [fx.root, join(fx.parent, 'gone')] })).roots).toHaveLength(2);
    // The valid form still loads, with defaults filled in.
    const loaded = loadConfig(configFor(fx));
    expect(loaded.roots).toEqual([fx.root]);
    expect(loaded.exclude).toContain('node_modules');
  });
});

/** Every path under a tree with its size, mtime and content hash. */
function snapshot(root: string): Record<string, string> {
  const rows: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        rows[full] = 'dir';
        walk(full);
        continue;
      }
      const stat = statSync(full);
      rows[full] = `${stat.size}:${stat.mtimeMs}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`;
    }
  };
  walk(root);
  return rows;
}