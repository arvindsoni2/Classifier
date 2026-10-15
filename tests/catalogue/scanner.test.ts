/**
 * Phase 1 Task 1: the read-only walk, config validation and store basics
 * (spec §5 Phase 1, plan Task 1).
 *
 * Volume handling moved to `scanner-volume.test.ts`; the safe-open, recorded
 * failure and mount-boundary rules live in `scanner-hardening.test.ts`. What is
 * left is what the walk itself decides: kinds, symlinks, excludes, virtualenvs,
 * incomplete files, and the promise that a scan writes nothing inside a root.
 *
 * Synthetic fixture trees only (AGENTS.md rule 3), through `scanner-world.ts`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/catalogue/config.js';
import { scan } from '../../src/catalogue/scanner.js';
import { pdfBytes } from './fixtures.js';
import { configFor, fixture, itemByName, items, storeFor } from './scanner-world.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('catalogue scanner (Phase 1 Task 1)', () => {
  it('catalogues nested files with kinds', async () => {
    const fx = fixture(cleanups, 'nested', [
      'top.txt',
      'one/two/three/report.pdf',
      'one/two/three/song.mp3',
      'one/deep/nested/notes.md',
    ]);
    const store = storeFor(cleanups, fx);
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
    const fx = fixture(cleanups, 'symlink-exclude', [
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
    const store = storeFor(cleanups, fx);
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
    const fx = fixture(cleanups, 'virtualenv', [
      'envs/torch_env/pyvenv.cfg',
      'envs/torch_env/lib/python3.12/site-packages/torch/include/header.h',
      'envs/torch_env/lib/python3.12/site-packages/pkg.py',
      'envs/myenv/pyvenv.cfg',
      'envs/myenv/bin/python',
      'envs/myenv/lib/site-packages/thing.py',
      'work/notes.txt',
      'work/data/values.csv',
    ]);
    const store = storeFor(cleanups, fx);
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
    const fx = fixture(cleanups, 'virtualenv-root', ['pyvenv.cfg', 'lib/site-packages/thing.py']);
    const store = storeFor(cleanups, fx);
    const result = await scan(loadConfig(configFor(fx)), store);

    const catalogued = items(store).map((row) => row.rel_path);
    expect(catalogued).toContain('lib/site-packages/thing.py');
    expect(catalogued).toContain('pyvenv.cfg');
    expect(result.totals.filesSeen).toBe(2);
  });

  it('a nested virtualenv does not hide its siblings', async () => {
    // The skip is per directory; it is not inherited by the parent.
    const fx = fixture(cleanups, 'virtualenv-nested', [
      'project/venv/pyvenv.cfg',
      'project/venv/lib/x.py',
      'project/src/main.py',
      'project/README.md',
    ]);
    const store = storeFor(cleanups, fx);
    await scan(loadConfig(configFor(fx)), store);

    expect(items(store).map((row) => row.rel_path)).toEqual(['project/README.md', 'project/src/main.py']);
  });

  it('marks incomplete and missing', async () => {
    const fx = fixture(cleanups, 'incomplete-missing', ['stable.txt', 'partial.crdownload', 'temp.tmp', 'soon-gone.txt']);
    const config = loadConfig(configFor(fx));
    const store = storeFor(cleanups, fx);

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
    const fx = fixture(cleanups, 'magic', [
      'report.bin', // actually a PDF: magic must beat the extension
      'photo.dat', // PNG magic
      'plain.dat', // no magic at all
    ]);
    fx.put('report.bin', pdfBytes('magic wins over a misleading extension'));
    fx.put('photo.dat', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]));
    fx.put('plain.dat', 'just words, no magic\n');
    const store = storeFor(cleanups, fx);
    await scan(loadConfig(configFor(fx)), store);

    expect(itemByName(store, 'report.bin')?.kind).toBe('document');
    expect(itemByName(store, 'photo.dat')?.kind).toBe('image');
    expect(itemByName(store, 'plain.dat')?.kind).toBe('other');
  });

  it('scan is read only', async () => {
    const fx = fixture(cleanups, 'readonly', ['a.txt', 'sub/b.txt', 'sub/c.pdf', 'sub/deep/d.txt']);
    const before = snapshot(fx.root);
    const store = storeFor(cleanups, fx);
    await scan(loadConfig(configFor(fx)), store);
    const after = snapshot(fx.root);

    expect(after).toEqual(before);
    // The store lives outside the root; nothing was written inside it.
    expect(existsSync(join(fx.root, 'catalogue.sqlite'))).toBe(false);
    expect(readdirSync(fx.root).sort()).toEqual(['a.txt', 'sub']);
  });

  it('config rejects nested roots and data dir inside root', () => {
    const fx = fixture(cleanups, 'config', ['a.txt']);
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