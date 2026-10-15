/**
 * Phase 1 Task 3: how bundles behave between scans, and on disk.
 *
 * Split out of `bundles.test.ts`: which rule fired is one question, and "the
 * catalogue updates rather than duplicates, and detection never writes to a root"
 * is another. The read-only check is the Phase 1 guarantee, so it gets its own
 * file rather than being one assertion among many.
 *
 * Everything runs on synthetic fixture trees (AGENTS.md rule 3).
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleScanHook, detectBundles, listBundles } from '../../src/catalogue/bundles.js';
import { scan } from '../../src/catalogue/scanner.js';
import { loadConfig } from '../../src/catalogue/config.js';
import { makeFixture } from './fixtures.js';
import { itemsUnder, media, scanFixture } from './bundle-world.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('bundles across scans, and detection on disk (Phase 1 Task 3)', () => {
  it('the root directory itself is never a bundle', async () => {
    const fixture = makeFixture('root-not-a-bundle');
    fixture.dir('.git');
    fixture.put('01 clip.mp4', media('01'));
    fixture.put('02 clip.mp4', media('02'));
    fixture.put('03 clip.mp4', media('03'));
    const { store } = await scanFixture(fixture, cleanups);

    // Even with a .git and three numbered videos at the top, the configured
    // root is scanned: bundling it would hide the entire root.
    expect(listBundles(store)).toEqual([]);
    expect(itemsUnder(store, '').map((item) => item.rel_path)).toEqual([
      '01 clip.mp4',
      '02 clip.mp4',
      '03 clip.mp4',
    ]);
  });

  it('a rescan updates bundle rows instead of duplicating them', async () => {
    const fixture = makeFixture('rescan');
    fixture.put('album/01 one.mp3', media('01'));
    fixture.put('album/02 two.mp3', media('02'));
    fixture.put('album/03 three.mp3', media('03'));
    fixture.put('app/pyproject.toml', '[project]\nname = "app"\n');
    fixture.put('app/main.py', 'print("hi")\n');

    const first = await scanFixture(fixture, cleanups);
    expect(listBundles(first.store)).toHaveLength(2);

    const configPath = join(fixture.parent, 'catalogue.json');
    const store = first.store;
    const second = await scan(loadConfig(configPath), store, { onDirectory: bundleScanHook(store) });
    detectBundles(store, second.scanId);

    const found = listBundles(store);
    expect(found).toHaveLength(2);
    expect(found.every((bundle) => bundle.detectedScan === second.scanId)).toBe(true);
    expect(found.map((bundle) => bundle.type).sort()).toEqual(['album', 'code_project']);
  });

  it('detection is read only on the roots', async () => {
    const fixture = makeFixture('readonly');
    fixture.put('album/01 one.mp3', media('01'));
    fixture.put('album/02 two.mp3', media('02'));
    fixture.put('album/03 three.mp3', media('03'));
    fixture.put('app/pyproject.toml', '[project]\n');
    fixture.put('app/main.py', 'print("hi")\n');

    const before = snapshot(fixture.root);
    await scanFixture(fixture, cleanups);
    expect(snapshot(fixture.root)).toEqual(before);
  });
});

/** (path, size, mtime) for every entry under a directory, recursively. */
function snapshot(dir: string): Record<string, string> {
  const rows: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        rows[full] = 'dir';
        walk(full);
        continue;
      }
      const stat = statSync(full);
      rows[full] = `${stat.size}:${stat.mtimeMs}`;
    }
  };
  walk(dir);
  return rows;
}
