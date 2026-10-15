/**
 * Task 7: the scanner's honesty rules — safe opens, recorded failures, mount
 * boundaries (plan docs/11-Phase-1-Plan.md Task 7 items 1, 2 and 7).
 *
 * Each test here is about something the scanner used to do quietly:
 *
 *  - it opened files with a plain `'r'`, so a file replaced by a FIFO between
 *    the listing and the open blocked the entire scan forever;
 *  - `readHead` returned an empty buffer for any open failure, which is
 *    indistinguishable from a file whose first bytes really are empty;
 *  - items under a directory that could not be listed were marked `missing`,
 *    so one `EACCES` looked exactly like a directory the user deleted;
 *  - a database failure was recorded as a per-file scan error and the scan
 *    carried on to `done`, which is a lie about what was written.
 *
 * Every tree here is synthetic (AGENTS.md rule 3) and every test runs in this
 * process's temporary directory.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/catalogue/config.js';
import { computeHashes } from '../../src/catalogue/dedupe.js';
import { MAX_EXTRACTOR_INPUT_BYTES, readFileBounded } from '../../src/catalogue/metadata/readfile.js';
import { scan, type ScanDirectoryContext } from '../../src/catalogue/scanner.js';
import { openStore, type CatalogueStore } from '../../src/catalogue/store.js';
import { ext4Probe, makeTree, type Fixture } from './fixtures.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** Root permission does not deny root, so a chmod fixture cannot prove anything. */
function runningAsRoot(): boolean {
  return process.getuid?.() === 0;
}

function fixture(label: string, entries: string[]): Fixture {
  const made = makeTree(label, entries);
  cleanups.push(made.cleanup);
  return made;
}

function storeFor(fx: Fixture): CatalogueStore {
  const store = openStore(join(fx.parent, 'data'));
  cleanups.push(() => store.close());
  return store;
}

function configFor(fx: Fixture): string {
  const path = join(fx.parent, 'catalogue.json');
  writeFileSync(
    path,
    JSON.stringify({ roots: [fx.root], dataDir: join(fx.parent, 'data') }),
    'utf8',
  );
  return path;
}

interface ErrorRow {
  rel_path: string;
  code: string;
  message: string;
}

function errorsOf(store: CatalogueStore, scanId: number): ErrorRow[] {
  return store.db
    .prepare('SELECT rel_path, code, message FROM scan_errors WHERE scan_id = ? ORDER BY id')
    .all(scanId) as ErrorRow[];
}

function itemPaths(store: CatalogueStore): string[] {
  const rows = store.db.prepare('SELECT rel_path FROM items ORDER BY rel_path').all() as {
    rel_path: string;
  }[];
  return rows.map((row) => row.rel_path);
}

/** Replaces `name` inside `dir` with something that is not a regular file. */
function swapIn(dir: ScanDirectoryContext, name: string, make: (path: string) => void): void {
  if (!dir.names.includes(name)) return;
  const target = join(dir.absPath, name);
  rmSync(target, { force: true });
  make(target);
}

describe('safe opens (Task 7 item 1)', () => {
  // Without `O_NONBLOCK`, opening a FIFO for reading waits for a writer that
  // never comes. The timeout on this test *is* the assertion: if the scanner
  // ever opens a swapped-in FIFO without it, this test fails by hanging.
  it(
    'a file swapped for a FIFO after the listing does not block the scan',
    async () => {
      const fx = fixture('fifo-swap', ['swap-me.txt', 'keep.txt']);
      const store = storeFor(fx);

      const result = await scan(loadConfig(configFor(fx)), store, {
        volumeProbe: ext4Probe(),
        onDirectory: (dir) => swapIn(dir, 'swap-me.txt', (path) => execFileSync('mkfifo', [path])),
      });

      // The FIFO is recorded as an error and never read, and the rest of the
      // directory is catalogued as normal.
      const errors = errorsOf(store, result.scanId);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.rel_path).toBe('swap-me.txt');
      expect(errors[0]?.code).toBe('NOT_A_REGULAR_FILE');
      expect(errors[0]?.message).toContain('fifo');
      expect(itemPaths(store)).toEqual(['keep.txt']);
    },
    15_000,
  );

  it(
    'a file swapped for a symlink after the listing is refused, not followed',
    async () => {
      const fx = fixture('symlink-swap', ['swap-me.txt', 'keep.txt', 'secret.txt']);
      // The symlink points at a file that is outside the root entirely, so
      // following it would read something the root does not contain.
      const outside = join(fx.parent, 'outside-the-root.txt');
      writeFileSync(outside, 'should never be read\n');
      cleanups.push(() => rmSync(outside, { force: true }));

      const store = storeFor(fx);
      const result = await scan(loadConfig(configFor(fx)), store, {
        volumeProbe: ext4Probe(),
        onDirectory: (dir) => swapIn(dir, 'swap-me.txt', (path) => symlinkSync(outside, path)),
      });

      const errors = errorsOf(store, result.scanId);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.rel_path).toBe('swap-me.txt');
      // `O_NOFOLLOW` turns the symlink into ELOOP at the open, not into a read.
      expect(errors[0]?.code).toBe('ELOOP');
      expect(itemPaths(store)).toEqual(['keep.txt', 'secret.txt']);
    },
    15_000,
  );

  it(
    'hashing a candidate swapped for a FIFO records an open error instead of hanging',
    async () => {
      const fx = fixture('fifo-hash', ['a/one.txt', 'a/two.txt']);
      const store = storeFor(fx);
      const first = await scan(loadConfig(configFor(fx)), store, { volumeProbe: ext4Probe() });

      // Two files of equal size so the size filter makes them hashing
      // candidates, then one of them is replaced by a FIFO.
      const victim = join(fx.root, 'a/one.txt');
      rmSync(victim, { force: true });
      execFileSync('mkfifo', [victim]);

      const summary = await computeHashes(store, first.scanId);
      expect(summary.openErrors).toBe(1);
    },
    15_000,
  );

  it(
    'reading a FIFO into an extractor buffer refuses it rather than blocking',
    async () => {
      const fx = fixture('fifo-readfile', ['pipe']);
      const fifo = join(fx.root, 'pipe');
      rmSync(fifo, { force: true });
      execFileSync('mkfifo', [fifo]);

      await expect(
        readFileBounded(fifo, MAX_EXTRACTOR_INPUT_BYTES, new AbortController().signal),
      ).rejects.toThrow(/not a regular file/i);
    },
    15_000,
  );
});

describe('no swallowed errors (Task 7 item 2)', () => {
  it('a file that cannot be opened is recorded, not silently catalogued as empty', async () => {
    if (runningAsRoot()) {
      console.warn('skipping an unopenable-file test: running as root');
      return;
    }
    const fx = fixture('unreadable-file', ['openable.txt', 'locked.txt']);
    const locked = join(fx.root, 'locked.txt');
    chmodSync(locked, 0o000);
    cleanups.push(() => chmodSync(locked, 0o644));
    const store = storeFor(fx);

    const result = await scan(loadConfig(configFor(fx)), store, { volumeProbe: ext4Probe() });

    // The point of the fix: the failure is a row, so `openable.txt` and
    // `locked.txt` are not quietly indistinguishable in the catalogue.
    const errors = errorsOf(store, result.scanId);
    expect(errors.map((row) => [row.rel_path, row.code])).toEqual([['locked.txt', 'EACCES']]);
  });

  it('items under a directory that could not be listed keep their previous state', async () => {
    if (runningAsRoot()) {
      console.warn('skipping an unlistable-directory test: running as root');
      return;
    }
    const fx = fixture('unlistable-dir', ['open/one.txt', 'blocked/inside.txt']);
    const store = storeFor(fx);
    await scan(loadConfig(configFor(fx)), store, { volumeProbe: ext4Probe() });
    expect(itemPaths(store).sort()).toEqual(['blocked/inside.txt', 'open/one.txt']);

    // The directory becomes unreadable. Its contents were not deleted by that,
    // and a scan must not record them as missing.
    const blocked = join(fx.root, 'blocked');
    chmodSync(blocked, 0o000);
    cleanups.push(() => chmodSync(blocked, 0o755));

    const second = await scan(loadConfig(configFor(fx)), store, { volumeProbe: ext4Probe() });

    const errors = errorsOf(store, second.scanId);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.rel_path).toBe('blocked');
    expect(errors[0]?.code).toBe('EACCES');
    const rows = store.db
      .prepare('SELECT rel_path, status, last_seen_scan FROM items ORDER BY rel_path')
      .all() as { rel_path: string; status: string; last_seen_scan: number }[];
    expect(rows.find((row) => row.rel_path === 'blocked/inside.txt')?.status).toBe('present');
  });

  it('a database failure fails the scan instead of being recorded as a scan error', async () => {
    const fx = fixture('db-failure', ['one.txt', 'two.txt']);
    const store = storeFor(fx);
    const broken: CatalogueStore = {
      ...store,
      upsertDir: () => {
        throw new Error('SQLITE_READONLY: attempt to write a readonly database');
      },
    };

    // A store that cannot write is not a per-file problem: the scan's totals
    // would be fiction, so it must stop and record the failure as its status.
    await expect(scan(loadConfig(configFor(fx)), broken, { volumeProbe: ext4Probe() })).rejects.toThrow(
      /SQLITE_READONLY/,
    );
    const scans = store.db.prepare('SELECT status, failure_stage FROM scans ORDER BY id').all() as {
      status: string;
      failure_stage: string | null;
    }[];
    expect(scans).toHaveLength(1);
    expect(scans[0]?.status).toBe('failed');
  });
});

describe('mount boundaries (Task 7 item 7)', () => {
  it('a directory on another device is recorded and never entered', async () => {
    const fx = fixture('mount-boundary', ['inside/one.txt', 'elsewhere/two.txt']);
    const store = storeFor(fx);
    // Every path reports the root's real device except one directory, which is
    // what a mounted filesystem looks like from inside a walk.
    const rootDev = (await lstat(fx.root, { bigint: true })).dev;
    const otherDevice = rootDev + 999n;
    const result = await scan(loadConfig(configFor(fx)), store, {
      volumeProbe: ext4Probe(),
      deviceOf: async (path) => (path.endsWith('elsewhere') ? otherDevice : rootDev),
    });

    const errors = errorsOf(store, result.scanId);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.rel_path).toBe('elsewhere');
    expect(errors[0]?.code).toBe('MOUNT_BOUNDARY');
    // Never entered: nothing under it is catalogued.
    expect(itemPaths(store)).toEqual(['inside/one.txt']);
  });
});