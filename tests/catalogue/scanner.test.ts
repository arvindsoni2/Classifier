/**
 * Phase 1 Task 1: read-only recursive scanner, config and store.
 *
 * Spec docs/10-Catalogue-First-Spec.md §5 Phase 1 and plan docs/11-Phase-1-Plan.md
 * Task 1. Every test uses a synthetic fixture tree (AGENTS.md rule 3) and
 * asserts observable invariants of the catalogue, never internals.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/catalogue/config.js';
import { scan } from '../../src/catalogue/scanner.js';
import { openStore, type CatalogueStore } from '../../src/catalogue/store.js';
import { makeTree, pdfBytes, type Fixture } from './fixtures.js';

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
    expect(() => loadConfig(configFor(fx, { roots: [join(fx.parent, 'does-not-exist')] }))).toThrow(
      /exist/i,
    );
    expect(() => loadConfig(configFor(fx, { roots: [notADirectory] }))).toThrow(/not a directory/i);
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