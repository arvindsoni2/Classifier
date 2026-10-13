/**
 * Phase 1 Task 2: duplicate detection (plan docs/11-Phase-1-Plan.md Task 2).
 *
 * Hashing rules under test: only size-shared present items are candidates;
 * the partial hash is size || first 64 KiB || last 64 KiB (whole file when
 * small); the full hash runs only where partials collide; hashes come from an
 * opened descriptor; unchanged items are never re-hashed; and hard links are
 * one copy, not a duplicate.
 *
 * Every test uses synthetic fixture trees (AGENTS.md rule 3).
 */
import { linkSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/catalogue/config.js';
import { computeHashes, duplicateGroups } from '../../src/catalogue/dedupe.js';
import { createHasher, type Hasher } from '../../src/catalogue/hashing.js';
import { scan } from '../../src/catalogue/scanner.js';
import { openStore, type CatalogueStore } from '../../src/catalogue/store.js';
import { makeRoots, type MultiRootFixture } from './fixtures.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function twoRoots(label: string): MultiRootFixture {
  const fixture = makeRoots(label, 2);
  cleanups.push(fixture.cleanup);
  return fixture;
}

/** A store plus a config file for the given fixture, both outside the roots. */
function setup(label: string, fixture: MultiRootFixture): { store: CatalogueStore; configPath: string } {
  const store = openStore(fixture.dataDir);
  cleanups.push(() => store.close());
  const configPath = join(fixture.dataDir, '..', 'catalogue.json');
  writeFileSync(
    configPath,
    JSON.stringify({ roots: fixture.roots, dataDir: fixture.dataDir }),
    'utf8',
  );
  return { store, configPath };
}

/** Wraps the real hasher with call counters, so tests can prove what ran. */
function countingHasher(): { hasher: Hasher; partialCalls: () => number; fullCalls: () => number } {
  const real = createHasher();
  let partial = 0;
  let full = 0;
  return {
    hasher: {
      partial: async (handle, size) => {
        partial += 1;
        return real.partial(handle, size);
      },
      full: async (handle) => {
        full += 1;
        return real.full(handle);
      },
    },
    partialCalls: () => partial,
    fullCalls: () => full,
  };
}

function groupPaths(groups: ReturnType<typeof duplicateGroups>): string[] {
  return groups.flatMap((group) => group.items.map((item) => `${item.rootPath}|${item.relPath}`));
}

describe('duplicate detection (Phase 1 Task 2)', () => {
  it('groups identical files across roots', async () => {
    const fixture = twoRoots('across-roots');
    const payload = 'the same bytes in three places\n';
    fixture.put(0, 'dup.txt', payload);
    fixture.put(0, 'nested/dup.txt', payload);
    fixture.put(1, 'dup.txt', payload);
    fixture.put(1, 'unique.txt', 'different bytes, not a duplicate\n');
    const { store, configPath } = setup('across-roots', fixture);

    const scanResult = await scan(loadConfig(configPath), store);
    await computeHashes(store, scanResult.scanId);

    const groups = duplicateGroups(store);
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group?.items).toHaveLength(3);
    expect(group?.copies).toBe(3);
    expect(group?.size).toBe(Buffer.byteLength(payload));
    expect(group?.wastedBytes).toBe(2 * Buffer.byteLength(payload));
    // One copy in each place, spanning both roots and a nested directory.
    const paths = groupPaths(groups);
    expect(paths).toContain(`${fixture.roots[0]}|dup.txt`);
    expect(paths).toContain(`${fixture.roots[0]}|nested/dup.txt`);
    expect(paths).toContain(`${fixture.roots[1]}|dup.txt`);
    expect(paths.some((path) => path.includes('unique.txt'))).toBe(false);
  });

  it('same size different content not grouped', async () => {
    const fixture = twoRoots('same-size');
    // Same size, different bytes: the partial hash must separate them and no
    // full hash may be computed at all.
    fixture.put(0, 'a.txt', 'aaaa');
    fixture.put(1, 'b.txt', 'bbbb');
    const { store, configPath } = setup('same-size', fixture);

    const scanResult = await scan(loadConfig(configPath), store);
    const counter = countingHasher();
    await computeHashes(store, scanResult.scanId, { hasher: counter.hasher });

    expect(counter.partialCalls()).toBe(2);
    expect(counter.fullCalls()).toBe(0);
    expect(duplicateGroups(store)).toEqual([]);
  });

  it('same head and tail different middle', async () => {
    const fixture = twoRoots('head-tail');
    const head = Buffer.alloc(64 * 1024, 0x48); // 'H'
    const tail = Buffer.alloc(64 * 1024, 0x54); // 'T'
    const first = Buffer.concat([head, Buffer.alloc(72 * 1024, 0x31), tail]); // > 128 KiB
    const second = Buffer.concat([head, Buffer.alloc(72 * 1024, 0x32), tail]);
    expect(first.length).toBe(second.length);
    fixture.put(0, 'one.bin', first);
    fixture.put(1, 'two.bin', second);
    const { store, configPath } = setup('head-tail', fixture);

    const scanResult = await scan(loadConfig(configPath), store);
    const counter = countingHasher();
    await computeHashes(store, scanResult.scanId, { hasher: counter.hasher });

    // The partial hashes collide (identical size, head and tail), so both
    // files are fully hashed — and the full hashes separate them.
    expect(counter.fullCalls()).toBe(2);
    const groups = duplicateGroups(store);
    expect(groups).toEqual([]);
    const rows = store.db
      .prepare('SELECT rel_path, sha256 FROM items WHERE sha256 IS NOT NULL')
      .all() as { rel_path: string; sha256: string }[];
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.sha256)).size).toBe(2);
  });

  it('hard links are not duplicates', async () => {
    const fixture = twoRoots('hard-links');
    const payload = 'one inode, two names\n';
    const target = fixture.put(0, 'real.txt', payload);
    const alias = join(fixture.roots[0] ?? '', 'alias.txt');
    linkSync(target, alias);
    const { store, configPath } = setup('hard-links', fixture);

    const scanResult = await scan(loadConfig(configPath), store);
    await computeHashes(store, scanResult.scanId);

    // Both names are catalogued and hashed to the same digest...
    const rows = store.db
      .prepare('SELECT rel_path, sha256, nlink FROM items ORDER BY rel_path')
      .all() as { rel_path: string; sha256: string | null; nlink: number }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.nlink === 2)).toBe(true);
    expect(new Set(rows.map((row) => row.sha256)).size).toBe(1);
    // ...but one inode is one copy, so no duplicate group is reported.
    expect(duplicateGroups(store)).toEqual([]);
  });

  it('rescan does not rehash unchanged files', async () => {
    const fixture = twoRoots('rescan');
    const payload = 'stable duplicate payload\n';
    fixture.put(0, 'one.txt', payload);
    fixture.put(1, 'two.txt', payload);
    const { store, configPath } = setup('rescan', fixture);
    const config = loadConfig(configPath);

    const first = await scan(config, store);
    const counter = countingHasher();
    await computeHashes(store, first.scanId, { hasher: counter.hasher });

    expect(counter.partialCalls()).toBe(2);
    expect(counter.fullCalls()).toBe(2);
    const firstRow = store.db
      .prepare('SELECT files_hashed FROM scans WHERE id = ?')
      .get(first.scanId) as { files_hashed: number };
    expect(firstRow.files_hashed).toBe(2);
    expect(duplicateGroups(store)).toHaveLength(1);

    // Nothing changed, so the second scan's hashing pass does no work at all.
    const second = await scan(config, store);
    const secondCounter = countingHasher();
    await computeHashes(store, second.scanId, { hasher: secondCounter.hasher });

    expect(secondCounter.partialCalls()).toBe(0);
    expect(secondCounter.fullCalls()).toBe(0);
    const secondRow = store.db
      .prepare('SELECT files_hashed FROM scans WHERE id = ?')
      .get(second.scanId) as { files_hashed: number };
    expect(secondRow.files_hashed).toBe(0);
    // The group survives: kept hashes are kept, not recomputed or dropped.
    expect(duplicateGroups(store)).toHaveLength(1);
  });

  it('hashing is read only on the roots', async () => {
    const fixture = twoRoots('readonly');
    const payload = 'read-only hashing proof\n';
    fixture.put(0, 'one.txt', payload);
    fixture.put(1, 'two.txt', payload);
    const { store, configPath } = setup('readonly', fixture);

    const before = snapshotRoots(fixture);
    const scanResult = await scan(loadConfig(configPath), store);
    await computeHashes(store, scanResult.scanId);
    expect(snapshotRoots(fixture)).toEqual(before);
  });
});

/** (path, size, mtime) for every file under the fixture's roots. */
function snapshotRoots(fixture: MultiRootFixture): Record<string, string> {
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
      rows[full] = `${stat.size}:${stat.mtimeMs}`;
    }
  };
  for (const root of fixture.roots) walk(root);
  return rows;
}