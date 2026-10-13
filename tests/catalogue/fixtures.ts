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