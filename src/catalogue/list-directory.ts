/**
 * Reading and classifying one directory's entries (plan Task 1, scanner rules
 * 2, 4 and 5).
 *
 * Split out of `scanner.ts` because it is a different question from the walk:
 * this decides *what is in this directory*, the walk decides *where to go next*
 * and what to write down. Keeping them apart also keeps both files readable.
 *
 * Nothing here follows anything. A symlink is counted and dropped; a socket,
 * FIFO or device is dropped; an excluded or hidden name never reaches the
 * caller.
 */
import { opendir } from 'node:fs/promises';
import { matchesExclude } from './config.js';

export interface Listing {
  /** Names of regular files, hidden and excluded entries removed. */
  files: string[];
  /** Names of subdirectories worth entering, in the same order. */
  dirs: string[];
  /** All entry names, including hidden ones and symlinks. */
  allNames: string[];
  /** Symlinks seen but never followed and never recorded. */
  symlinks: number;
  fileCount: number;
  dirCount: number;
}

/** A leading dot: hidden names are never catalogued (scanner rule 5). */
export function isHidden(name: string): boolean {
  return name.startsWith('.');
}

/** One directory's listing, filtered and classified. */
export async function listDirectory(absPath: string, exclude: readonly string[]): Promise<Listing> {
  const files: string[] = [];
  const dirs: string[] = [];
  const allNames: string[] = [];
  let symlinks = 0;
  const dir = await opendir(absPath);
  for await (const entry of dir) {
    allNames.push(entry.name);
    if (entry.isSymbolicLink()) {
      // Counted for the totals; nothing is recorded and nothing is followed.
      symlinks += 1;
      continue;
    }
    if (matchesExclude(entry.name, exclude)) continue;
    if (entry.isFile()) {
      if (isHidden(entry.name)) continue;
      files.push(entry.name);
      continue;
    }
    if (entry.isDirectory()) {
      if (isHidden(entry.name)) continue;
      dirs.push(entry.name);
      continue;
    }
    // Sockets, FIFOs, character and block devices: skipped by design.
  }
  return { files, dirs, allNames, symlinks, fileCount: files.length, dirCount: dirs.length };
}