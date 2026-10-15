/**
 * Synthetic fixture trees for the catalogue tests.
 *
 * AGENTS.md rule 3: every automated test builds its tree in a temporary
 * directory. Nothing here ever touches a real home directory, Downloads
 * folder or Drive account.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { VolumeProbe } from '../../src/catalogue/scanner.js';
import { absent, probeFailed } from '../../src/catalogue/volume.js';

export interface Fixture {
  /** Absolute path of the fixture root (the scanned directory). */
  root: string;
  /** Absolute path of the fixture's parent, for sibling/mount fixtures. */
  parent: string;
  /** Write a file relative to the root, creating parents. */
  put(relPath: string, contents: string | Buffer): string;
  /** Create a directory relative to the root. */
  dir(relPath: string): string;
  cleanup(): void;
}

/** A byte sequence that starts with the given PDF magic. */
export function pdfBytes(body = 'minimal catalogue fixture'): Buffer {
  return Buffer.from(`%PDF-1.7\n${body}\n%%EOF\n`, 'utf8');
}

/** Builds a throwaway tree under the OS temp dir. */
export function makeFixture(label: string): Fixture {
  const parent = mkdtempSync(join(tmpdir(), `catalogue-${label}-`));
  const root = join(parent, 'Downloads');
  mkdirSync(root, { recursive: true });
  return {
    root,
    parent,
    put(relPath, contents) {
      const target = join(root, relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
      return target;
    },
    dir(relPath) {
      const target = join(root, relPath);
      mkdirSync(target, { recursive: true });
      return target;
    },
    cleanup() {
      rmSync(parent, { recursive: true, force: true });
    },
  };
}

/**
 * Builds the fixture named by a compact spec, so a test can describe its
 * whole tree in one place: `['a.txt', 'deep/b.pdf', 'deep/empty/']`.
 */
export function makeTree(label: string, entries: string[]): Fixture {
  const fixture = makeFixture(label);
  for (const entry of entries) {
    if (entry.endsWith('/')) {
      fixture.dir(entry.slice(0, -1));
      continue;
    }
    const extension = entry.slice(entry.lastIndexOf('.') + 1).toLowerCase();
    const contents = extension === 'pdf' ? pdfBytes(entry) : `fixture ${entry}\n`;
    fixture.put(entry, contents);
  }
  return fixture;
}

/**
 * A `VolumeProbe` that always reports the same ext4 volume, whatever path it is
 * asked about. Task 1a passes this to every scan so volume recording is
 * exercised without depending on the machine's real filesystem.
 */
export function ext4Probe(uuid = '11111111-2222-3333-4444-555555555555'): VolumeProbe {
  return async (path: string) => ({ kind: 'found', volume: { uuid, label: 'fixture', fstype: 'ext4', mountPoint: path } });
}

/** A probe that reports `offlineRoots` as missing and everything else as ext4. */
export function probeWithOfflineRoots(offlineRoots: readonly string[]): VolumeProbe {
  const base = ext4Probe();
  return async (path: string) => (offlineRoots.includes(path) ? absent() : base(path));
}

/** A probe that cannot answer for any path, for the `probe_failed` rules. */
export function failingProbe(reason: string): VolumeProbe {
  return async () => probeFailed(reason);
}

export interface MultiRootFixture {
  /** Absolute paths of the scanned roots, in configuration order. */
  roots: string[];
  /** Data directory outside every root, as the config requires. */
  dataDir: string;
  /** Writes a file into root `index` at `relPath`. */
  put(rootIndex: number, relPath: string, contents: string | Buffer): string;
  cleanup(): void;
}

/**
 * A fixture with several sibling roots under one temp parent, for tests that
 * need duplicates across roots. The data directory sits beside the roots,
 * never inside one.
 */
export function makeRoots(label: string, count: number): MultiRootFixture {
  const parent = mkdtempSync(join(tmpdir(), `catalogue-${label}-`));
  const roots: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const root = join(parent, `root${index}`);
    mkdirSync(root, { recursive: true });
    roots.push(root);
  }
  return {
    roots,
    dataDir: join(parent, 'data'),
    put(rootIndex, relPath, contents) {
      const root = roots[rootIndex];
      if (root === undefined) throw new Error(`fixture has no root ${rootIndex}`);
      const target = join(root, relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
      return target;
    },
    cleanup() {
      rmSync(parent, { recursive: true, force: true });
    },
  };
}