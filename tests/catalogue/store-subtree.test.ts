/**
 * Task 7 item 4: the subtree SQL matches a path prefix exactly (plan Task 7,
 * review `phase-1-volumes` should-fix 1).
 *
 * These three queries — `subtreeItemStats`, `setItemsBundleInSubtree` and
 * `setBundlesParentInSubtree` — decide what an `extracted_archive` owns. They
 * used an unescaped `LIKE '<path>/%'`, which is wrong in two separate ways:
 *
 *  - SQLite's `LIKE` ignores ASCII case, so `files/%` also matched `Files/inner`;
 *  - `_` is a single-character wildcard, so `my_files/%` also matched
 *    `myXfiles/inner`.
 *
 * Either way one archive quietly claimed a sibling directory's files and made it
 * its own child bundle. The fix is a plain prefix comparison that cannot be
 * reinterpreted:
 * `substr(rel_path, 1, length(@relPath) + 1) = @relPath || '/'`.
 *
 * Driven at the store rather than through bundle detection, because the bug is in
 * the SQL: a fixture tree cannot produce a `Files` beside a `files` and then
 * assert which rows moved without re-testing the whole pipeline. Every directory
 * below is created by hand so the near misses are exactly the strings that used to
 * collide, and no real filesystem is involved (AGENTS.md rule 3).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type CatalogueStore, type DirRow, type ItemRow } from '../../src/catalogue/store.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface DirSpec {
  relPath: string;
  /** Files placed directly inside this directory. */
  files?: readonly string[];
}

interface World {
  store: CatalogueStore;
  rootId: number;
  scanId: number;
  dirId: (relPath: string) => number;
  bundleId: (relPath: string, type?: 'course' | 'album') => number;
}

/**
 * A catalogue holding `specs`, each directory with its files, all in one root.
 * The data directory is a temporary path; nothing is written to any root.
 */
function worldWith(specs: readonly DirSpec[]): World {
  const dataDir = mkdtempSync(join(tmpdir(), 'catalogue-subtree-'));
  const store = openStore(dataDir);
  cleanups.push(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const scanId = store.startScan('2026-10-15T00:00:00.000Z');
  const rootId = store.upsertRoot('/synthetic/root', '1', '1', '2026-10-15T00:00:00.000Z', scanId);
  const dirIds = new Map<string, number>();
  const itemRows: ItemRow[] = [];

  for (const spec of specs) {
    const dirId = store.upsertDir({
      rootId,
      relPath: spec.relPath,
      dev: '1',
      ino: String(dirIds.size + 10),
      fileCount: spec.files?.length ?? 0,
      dirCount: 0,
      lastSeenScan: scanId,
    } satisfies DirRow);
    dirIds.set(spec.relPath, dirId);
    for (const name of spec.files ?? []) {
      itemRows.push({
        rootId,
        relPath: spec.relPath === '' ? name : `${spec.relPath}/${name}`,
        dirId,
        name,
        ext: 'txt',
        kind: 'document',
        size: 100,
        mtimeNs: '1000000000',
        dev: '1',
        ino: String(itemRows.length + 100),
        nlink: 1,
        status: 'present',
        scanId,
      } satisfies ItemRow);
    }
  }
  store.upsertItems(itemRows);

  return {
    store,
    rootId,
    scanId,
    dirId: (relPath) => {
      const id = dirIds.get(relPath);
      if (id === undefined) throw new Error(`no directory ${relPath} in this world`);
      return id;
    },
    bundleId: (relPath, type = 'album') =>
      store.upsertBundle({
        rootId,
        relPath,
        type,
        parentBundleId: null,
        rule: 'fixture',
        memberCount: null,
        totalSize: null,
        detectedScan: scanId,
      }),
  };
}

/** The bundles that ended up with `parentBundleId` set, by rel_path. */
function childrenOf(store: CatalogueStore, bundleId: number): string[] {
  const rows = store.db
    .prepare('SELECT rel_path FROM bundles WHERE parent_bundle_id = ? ORDER BY rel_path')
    .all(bundleId) as { rel_path: string }[];
  return rows.map((row) => row.rel_path);
}

/** Which bundle claims each item path, by rel_path. */
function claimedBy(store: CatalogueStore): Map<string, number | null> {
  const rows = store.db.prepare('SELECT rel_path, bundle_id FROM items ORDER BY rel_path').all() as {
    rel_path: string;
    bundle_id: number | null;
  }[];
  return new Map(rows.map((row) => [row.rel_path, row.bundle_id]));
}

describe('subtree SQL matches a path prefix exactly (Task 7 item 4)', () => {
  // Three archives' worth of near misses, all under one root:
  //   files/inner    belongs to the archive 'files'
  //   Files/inner    differs only in case          → `LIKE` matched it
  //   filesX/inner   shares a prefix, is not below → guards a `LIKE 'files%'` fix
  //   my_files/inner belongs to the archive 'my_files'
  //   myXfiles/inner differs at the `_`           → `LIKE`'s wildcard matched it
  const SPECS: readonly DirSpec[] = [
    { relPath: '', files: ['top.txt'] },
    { relPath: 'files', files: ['readme.txt'] },
    { relPath: 'files/inner', files: ['own.txt'] },
    { relPath: 'Files/inner', files: ['other.txt'] },
    { relPath: 'filesX/inner', files: ['prefix.txt'] },
    { relPath: 'my_files', files: ['readme.txt'] },
    { relPath: 'my_files/inner', files: ['own.txt'] },
    { relPath: 'myXfiles/inner', files: ['other.txt'] },
  ];

  it('counts only the subtree that belongs to the archive', () => {
    const w = worldWith(SPECS);
    // 'files' itself plus 'files/inner': two files, 200 bytes. The `Files/inner`
    // sibling contributes nothing, and neither does 'filesX/inner'.
    expect(w.store.subtreeItemStats(w.rootId, 'files')).toEqual({ files: 2, bytes: 200 });
    expect(w.store.subtreeItemStats(w.rootId, 'my_files')).toEqual({ files: 2, bytes: 200 });
  });

  it('counts an unknown subtree as empty rather than matching everything', () => {
    // A path that is not in the catalogue matches nothing. Under `LIKE` a stray
    // wildcard-free prefix could still have swept up unrelated rows.
    const w = worldWith(SPECS);
    expect(w.store.subtreeItemStats(w.rootId, 'no-such-directory')).toEqual({ files: 0, bytes: 0 });
  });

  it('claims only its own items', () => {
    const w = worldWith(SPECS);
    const archive = w.bundleId('files', 'album');
    const claimed = w.store.setItemsBundleInSubtree(w.rootId, 'files', archive);
    expect(claimed).toBe(2);

    const byPath = claimedBy(w.store);
    expect(byPath.get('files/readme.txt')).toBe(archive);
    expect(byPath.get('files/inner/own.txt')).toBe(archive);
    // Every near miss stays loose, and so does the root's own top-level file.
    expect(byPath.get('Files/inner/other.txt')).toBeNull();
    expect(byPath.get('filesX/inner/prefix.txt')).toBeNull();
    expect(byPath.get('top.txt')).toBeNull();
  });

  it('does not claim a sibling that differs at an underscore', () => {
    const w = worldWith(SPECS);
    const archive = w.bundleId('my_files', 'album');
    expect(w.store.setItemsBundleInSubtree(w.rootId, 'my_files', archive)).toBe(2);

    const byPath = claimedBy(w.store);
    expect(byPath.get('my_files/inner/own.txt')).toBe(archive);
    expect(byPath.get('myXfiles/inner/other.txt')).toBeNull();
  });

  it('makes only its own nested bundles children', () => {
    const w = worldWith(SPECS);
    const archive = w.bundleId('files', 'album');
    // A nested album inside the archive, and two look-alikes that are not inside.
    w.bundleId('files/inner', 'album');
    w.bundleId('Files/inner', 'album');
    w.bundleId('filesX/inner', 'album');

    expect(w.store.setBundlesParentInSubtree(w.rootId, 'files', archive)).toBe(1);
    expect(childrenOf(w.store, archive)).toEqual(['files/inner']);
  });

  it('does not re-parent a bundle that is already somebody else’s child', () => {
    // The query guards `parent_bundle_id IS NULL OR = @bundleId` so a second
    // archive scan cannot steal a bundle that already has a parent.
    const w = worldWith(SPECS);
    const archive = w.bundleId('files', 'album');
    const other = w.bundleId('my_files', 'album');
    const nested = w.bundleId('files/inner', 'album');
    w.store.setBundleParent(nested, other);

    expect(w.store.setBundlesParentInSubtree(w.rootId, 'files', archive)).toBe(0);
    expect(childrenOf(w.store, archive)).toEqual([]);
  });
});