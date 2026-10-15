/**
 * The shared harness for the scanner tests (plan Task 1).
 *
 * `scanner.test.ts` and `scanner-volume.test.ts` build the same kinds of fixture,
 * open a store beside it, and write the same config. Keeping that in one place
 * means the two files cannot drift into testing different setups, and the
 * cleanups are passed in so each test file still owns its own teardown.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore, type CatalogueStore } from '../../src/catalogue/store.js';
import { makeTree, type Fixture } from './fixtures.js';

export interface ItemRow {
  rel_path: string;
  kind: string;
  size: number;
  status: string;
}

export function fixture(cleanups: (() => void)[], label: string, entries: string[]): Fixture {
  const made = makeTree(label, entries);
  cleanups.push(made.cleanup);
  return made;
}

/** Registers a closeable (a store, a database) with the caller's teardown. */
export function track<T>(cleanups: (() => void)[], value: T): T {
  cleanups.push(() => {
    if (typeof value === 'object' && value !== null && 'close' in value) {
      (value as { close(): void }).close();
    }
  });
  return value;
}

/** Opens a store in the fixture's parent so no data lands inside the root. */
export function storeFor(cleanups: (() => void)[], fx: Fixture): CatalogueStore {
  return track(cleanups, openStore(join(fx.parent, 'data')));
}

export function items(store: CatalogueStore): ItemRow[] {
  return store.db
    .prepare('SELECT rel_path, kind, size, status FROM items ORDER BY rel_path')
    .all() as ItemRow[];
}

export function itemByName(store: CatalogueStore, name: string): ItemRow | undefined {
  return items(store).find((row) => row.rel_path === name || row.rel_path.endsWith(`/${name}`));
}

/** Writes a config beside the fixture and returns its path. */
export function configFor(fx: Fixture, overrides: Record<string, unknown> = {}): string {
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