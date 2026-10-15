/**
 * A two-root world for volume tests: one root on the machine's own disk, one
 * meant to be an external drive.
 *
 * The probe is injected, so every test runs on a machine with no drive attached,
 * and it answers per path — a probe that returned one answer for everything
 * could not tell "this drive changed" from "this disk changed".
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/catalogue/config.js';
import { scan, type ScanResult, type VolumeInfo, type VolumeProbe } from '../../src/catalogue/scanner.js';
import { absent, probeFailed } from '../../src/catalogue/volume.js';
import { openStore, type CatalogueStore } from '../../src/catalogue/store.js';
import { makeFixture, type Fixture } from './fixtures.js';

/** The laptop's own disk: an inode filesystem, so identity is inode-based. */
export const LAPTOP_FS: Omit<VolumeInfo, 'mountPoint'> = { uuid: 'laptop-uuid', label: 'fedora', fstype: 'btrfs' };

/** A volume description without its mount point, which is always the drive. */
export type DriveFs = Omit<VolumeInfo, 'mountPoint'> & { mountPoint?: string };

export interface World {
  fixture: Fixture;
  store: CatalogueStore;
  /** A root on the machine's own disk. */
  root: string;
  /** A root that is meant to be an external drive. */
  drive: string;
  roots: string[];
  /**
   * What the drive is now. `null` is "not there at all" — an unplugged drive
   * whose automount directory has gone too. A description without a mount point
   * means the drive is mounted at its own root.
   */
  driveIs: (fs: DriveFs | null) => void;
  /**
   * Makes the drive's probe stop answering, the way a broken `findmnt` would.
   * Distinct from `driveIs(null)`: the drive may well still be plugged in, and
   * the catalogue must not conclude otherwise.
   */
  driveFails: (reason: string) => void;
  probe: VolumeProbe;
}

export function world(label: string, initialDrive: DriveFs | null, cleanups: (() => void)[]): World {
  const fixture = makeFixture(label);
  const store = openStore(join(fixture.parent, 'data'));
  cleanups.push(() => store.close());
  const root = join(fixture.root, 'laptop');
  const drive = join(fixture.root, 'drive');
  fixture.put('laptop/notes.txt', 'on the laptop disk\n');
  fixture.put('laptop/photo.txt', 'also on the laptop disk\n');
  fixture.put('drive/movie.mp4', 'a film on the external drive\n');
  fixture.put('drive/notes.txt', 'on the external drive\n');

  let override: DriveFs | null = initialDrive;
  let failure: string | null = null;
  const describe = (fs: DriveFs): VolumeInfo => ({ ...fs, mountPoint: fs.mountPoint ?? drive });
  return {
    fixture,
    store,
    root,
    drive,
    roots: [root, drive],
    probe: async (path) => {
      if (path !== drive) return { kind: 'found', volume: { ...LAPTOP_FS, mountPoint: root } };
      if (failure !== null) return probeFailed(failure);
      return override === null ? absent() : { kind: 'found', volume: describe(override) };
    },
    driveIs: (fs) => {
      override = fs;
      failure = null;
    },
    driveFails: (reason) => (failure = reason),
  };
}

export function scanWorld(world: World): Promise<ScanResult> {
  const configPath = join(world.fixture.parent, 'catalogue.json');
  writeFileSync(
    configPath,
    JSON.stringify({ roots: world.roots, dataDir: join(world.fixture.parent, 'data') }),
    'utf8',
  );
  return scan(loadConfig(configPath), world.store, { volumeProbe: world.probe });
}

export interface ItemRowOut {
  rel_path: string;
  status: string;
  sha256: string | null;
}

export function itemsOf(store: CatalogueStore, rootPath: string): ItemRowOut[] {
  return store.db
    .prepare(
      `SELECT i.rel_path, i.status, i.sha256 FROM items i JOIN roots r ON r.id = i.root_id
       WHERE r.path = ? ORDER BY i.rel_path`,
    )
    .all(rootPath) as ItemRowOut[];
}

export function rootRow(store: CatalogueStore, rootPath: string): Record<string, unknown> {
  return store.db.prepare('SELECT * FROM roots WHERE path = ?').get(rootPath) as Record<string, unknown>;
}

export function volumeErrors(store: CatalogueStore, scanId: number): { rel_path: string; message: string }[] {
  return store.db
    .prepare("SELECT rel_path, message FROM scan_errors WHERE scan_id = ? AND code = 'VOLUME_CHANGED'")
    .all(scanId) as { rel_path: string; message: string }[];
}

/** Empties the drive's mount point, as an automount directory would be. */
export function emptyMountPoint(world: World): void {
  rmSync(world.drive, { recursive: true, force: true });
  mkdirSync(world.drive, { recursive: true });
}

/** Re-upserts a root's items with chosen identity fields, at the store. */
export function reupsert(
  w: World,
  scanId: number,
  fields: (row: { rel_path: string; size: number; mtime_ns: string; ino: string }) => {
    relPath?: string;
    size?: number;
    mtimeNs?: string;
    dev?: string;
    ino?: string;
  },
): void {
  const rootId = (w.store.db.prepare('SELECT id FROM roots WHERE path = ?').get(w.drive) as { id: number }).id;
  const rows = w.store.db.prepare('SELECT rel_path, size, mtime_ns, ino FROM items WHERE root_id = ?').all(rootId) as {
    rel_path: string;
    size: number;
    mtime_ns: string;
    ino: string;
  }[];
  const dirId = (w.store.db.prepare('SELECT dir_id FROM items WHERE root_id = ? LIMIT 1').get(rootId) as {
    dir_id: number;
  }).dir_id;
  w.store.upsertItems(
    rows.map((row) => {
      const changed = fields(row);
      return {
        rootId,
        relPath: changed.relPath ?? row.rel_path,
        dirId,
        name: changed.relPath ?? row.rel_path,
        ext: 'mp4',
        kind: 'video' as const,
        size: changed.size ?? row.size,
        mtimeNs: changed.mtimeNs ?? row.mtime_ns,
        dev: changed.dev ?? '8:1',
        ino: changed.ino ?? row.ino,
        nlink: 1,
        status: 'present' as const,
        scanId,
      };
    }),
  );
}
