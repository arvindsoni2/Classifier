/**
 * The shared harness for the bundle tests (plan Task 3).
 *
 * Both `bundles.test.ts` and `bundles-archive.test.ts` scan a fixture with
 * bundle detection wired in and then ask the catalogue what it decided. That
 * setup is identical, and duplicating it in two files would let the two drift
 * apart — so it lives here, with the cleanups passed in by the caller so each
 * test file still owns its own teardown.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundleScanHook, detectBundles } from '../../src/catalogue/bundles.js';
import { loadConfig } from '../../src/catalogue/config.js';
import { scan } from '../../src/catalogue/scanner.js';
import { openStore, type CatalogueStore } from '../../src/catalogue/store.js';
import type { Fixture } from './fixtures.js';

export interface Scanned {
  store: CatalogueStore;
  scanId: number;
  fixture: Fixture;
}

/** Scans a fixture with bundle detection wired in, then evaluates post-scan rules. */
export async function scanFixture(fixture: Fixture, cleanups: (() => void)[]): Promise<Scanned> {
  const dataDir = join(fixture.parent, 'data');
  const store = openStore(dataDir);
  cleanups.push(() => store.close());
  const configPath = join(fixture.parent, 'catalogue.json');
  writeFileSync(configPath, JSON.stringify({ roots: [fixture.root], dataDir }), 'utf8');
  const result = await scan(loadConfig(configPath), store, { onDirectory: bundleScanHook(store) });
  detectBundles(store, result.scanId);
  return { store, scanId: result.scanId, fixture };
}

/**
 * Item rows at `relPath` itself or anywhere below it.
 *
 * The prefix test is `substr`, not `LIKE`, and deliberately so: this helper is
 * the yardstick the bundle tests measure against, and a yardstick with the same
 * wildcard bug as the code would agree with the bug.
 */
export function itemsUnder(store: CatalogueStore, relPath: string): { rel_path: string; bundle_id: number | null }[] {
  if (relPath === '') {
    return store.db.prepare('SELECT rel_path, bundle_id FROM items ORDER BY rel_path').all() as {
      rel_path: string;
      bundle_id: number | null;
    }[];
  }
  return store.db
    .prepare(
      `SELECT rel_path, bundle_id FROM items
       WHERE rel_path = ? OR substr(rel_path, 1, length(?) + 1) = ? || '/' ORDER BY rel_path`,
    )
    .all(relPath, relPath, relPath) as { rel_path: string; bundle_id: number | null }[];
}

/** A video/audio/image payload; the kind comes from the extension, bytes are irrelevant. */
export function media(label: string): string {
  return `synthetic ${label} payload\n`;
}