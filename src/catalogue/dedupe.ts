/**
 * Duplicate detection (plan Task 2 rules 1–6).
 *
 * The pass is deliberately staged so work is proportional to doubt:
 *   1. candidates are `present` items whose size is shared with at least one
 *      other present item, across all roots — nothing unique is ever read;
 *   2. a partial hash (size || first 64 KiB || last 64 KiB) is computed only
 *      for candidates that do not already have one;
 *   3. a full SHA-256 is computed only where partial hashes collide and the
 *      item has no full hash yet.
 *
 * Unchanged items keep their hashes (Task 1 rule 9 clears them on change), so
 * a rescan of an unchanged tree reads nothing.
 *
 * What counts as *one copy* depends on the root's filesystem (Task 1b). On an
 * inode filesystem two paths with the same inode are the same file — a hard link
 * — and never a duplicate. On vfat, exfat and ntfs the inode numbers are
 * synthetic and change between mounts, so inode says nothing: there each path is
 * its own copy. Counting by inode everywhere would make every duplicate group on
 * an external drive vanish from the report, which is the one place they matter.
 *
 * This module owns the dedupe policy and its read queries; writes go through
 * the store's methods. Candidate rows are materialised per stage (bounded by
 * the files that actually need hashing this run), because writing rows while
 * a better-sqlite3 iterator is open is unsafe.
 */
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createHasher, type Hasher, type HashOutcome } from './hashing.js';
import type { CatalogueStore } from './store.js';

export interface DuplicateItem {
  rootPath: string;
  relPath: string;
  size: number;
  dev: string;
  ino: string;
}

export interface DuplicateGroup {
  sha256: string;
  size: number;
  /**
   * Distinct files holding these bytes. On an inode-mode root, hard links are
   * one copy; on a path-mode root every path is its own copy, because inodes
   * there are synthetic and cannot tell two files apart.
   */
  copies: number;
  /** (copies − 1) × size. */
  wastedBytes: number;
  /** Every catalogued path to these bytes, hard-link siblings included. */
  items: DuplicateItem[];
}

export interface HashRunSummary {
  /** Size-shared present items considered, whether or not they needed work. */
  candidates: number;
  partialHashed: number;
  fullHashed: number;
  /** Distinct files any hash was computed for; the scan row's `files_hashed`. */
  filesHashed: number;
  changedDuringHash: number;
  openErrors: number;
}

export interface ComputeHashesOptions {
  /** Injectable for tests; defaults to the real streaming hasher. */
  hasher?: Hasher;
}

interface CandidateRow {
  root_id: number;
  rel_path: string;
  size: number;
  root_path: string;
}

const CANDIDATE_BASE = `
  SELECT i.root_id, i.rel_path, i.size, r.path AS root_path
  FROM items i
  JOIN roots r ON r.id = i.root_id
  WHERE i.status = 'present'
    AND i.size > 0
    AND i.size IN (
      SELECT size FROM items
      WHERE status = 'present' AND size > 0
      GROUP BY size HAVING COUNT(*) >= 2
    )`;

const OPEN_ERROR = 'OPEN_ERROR';

/**
 * Opens one candidate read-only and runs `run` on the descriptor.
 * The descriptor is closed before anything is persisted.
 */
async function withCandidateOpen(
  row: CandidateRow,
  run: (handle: FileHandle) => Promise<HashOutcome>,
): Promise<HashOutcome | { ok: false; code: string; detail: string; openFailure: true }> {
  const absPath = join(row.root_path, row.rel_path);
  let handle: FileHandle | null = null;
  try {
    handle = await open(absPath, 'r');
    return await run(handle);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return {
      ok: false,
      code: typeof code === 'string' ? code : OPEN_ERROR,
      detail: `cannot open ${absPath} for hashing: ${(error as Error).message}`,
      openFailure: true,
    };
  } finally {
    await handle?.close();
  }
}

/**
 * Hashes every candidate that needs it and records `files_hashed` on the scan.
 * Read-only on the roots; the only writes are catalogue rows.
 */
export async function computeHashes(
  store: CatalogueStore,
  scanId: number,
  options: ComputeHashesOptions = {},
): Promise<HashRunSummary> {
  const hasher = options.hasher ?? createHasher();
  const summary: HashRunSummary = {
    candidates: 0,
    partialHashed: 0,
    fullHashed: 0,
    filesHashed: 0,
    changedDuringHash: 0,
    openErrors: 0,
  };
  // Bounded by the work this pass actually does, not by the catalogue's size.
  const hashedThisRun = new Set<string>();
  const markHashed = (row: CandidateRow): void => {
    const key = `${row.root_id}:${row.rel_path}`;
    if (!hashedThisRun.has(key)) {
      hashedThisRun.add(key);
      summary.filesHashed += 1;
    }
  };

  const candidateCount = store.db
    .prepare(`SELECT COUNT(*) AS n FROM (${CANDIDATE_BASE})`)
    .get() as { n: number };
  summary.candidates = candidateCount.n;

  // Stage 1: partial hashes for candidates that lack one.
  const needPartial = store.db.prepare(`${CANDIDATE_BASE} AND i.partial_hash IS NULL`).all() as CandidateRow[];
  for (const row of needPartial) {
    const outcome = await withCandidateOpen(row, (handle) => hasher.partial(handle, row.size));
    if (outcome.ok) {
      store.setItemPartialHash(row.root_id, row.rel_path, outcome.hash);
      markHashed(row);
      summary.partialHashed += 1;
    } else if ('openFailure' in outcome) {
      summary.openErrors += 1;
      store.addErrors([{ scanId, rootId: row.root_id, relPath: row.rel_path, code: outcome.code, message: outcome.detail }]);
    } else {
      summary.changedDuringHash += 1;
      store.addErrors([{ scanId, rootId: row.root_id, relPath: row.rel_path, code: outcome.code, message: outcome.detail }]);
    }
  }

  // Stage 2: full hashes only where partial hashes collide.
  const needFull = store.db
    .prepare(
      `${CANDIDATE_BASE}
       AND i.partial_hash IN (
         SELECT partial_hash FROM items
         WHERE status = 'present' AND partial_hash IS NOT NULL
         GROUP BY partial_hash HAVING COUNT(*) >= 2
       )
       AND i.sha256 IS NULL`,
    )
    .all() as CandidateRow[];
  for (const row of needFull) {
    const outcome = await withCandidateOpen(row, (handle) => hasher.full(handle));
    if (outcome.ok) {
      store.setItemFullHash(row.root_id, row.rel_path, outcome.hash);
      markHashed(row);
      summary.fullHashed += 1;
    } else if ('openFailure' in outcome) {
      summary.openErrors += 1;
      store.addErrors([{ scanId, rootId: row.root_id, relPath: row.rel_path, code: outcome.code, message: outcome.detail }]);
    } else {
      summary.changedDuringHash += 1;
      store.addErrors([{ scanId, rootId: row.root_id, relPath: row.rel_path, code: outcome.code, message: outcome.detail }]);
    }
  }

  store.setFilesHashed(scanId, summary.filesHashed);
  return summary;
}

interface GroupHeadRow {
  sha256: string;
  size: number;
  copies: number;
}

/**
 * Groups of ≥ 2 present items with equal `sha256`, hard links collapsed to one
 * copy, sorted by wasted bytes descending. Empty array when nothing collides.
 *
 * `scanId` restricts the answer to the items that scan catalogued, which is
 * what a report about one scan needs: a group is only meaningful if its members
 * were all seen in the same run.
 */
export function duplicateGroups(store: CatalogueStore, scanId?: number): DuplicateGroup[] {
  // Two prepared variants rather than one with an optional clause: a statement
  // must not be handed a named parameter its SQL never mentions, and the
  // members query already carries a positional one.
  const scoped = scanId === undefined ? '' : ' AND i.last_seen_scan = @scanId';
  // One expression for "which file is this", chosen per row by the root's
  // identity mode: inode and device where inodes are real, root and path where
  // they are synthetic.
  const headsSql = (clause: string): string =>
    `SELECT sha256, size,
            COUNT(DISTINCT CASE WHEN r.identity_mode = 'path'
                                THEN i.root_id || ':' || i.rel_path
                                ELSE i.dev || ':' || i.ino END) AS copies
     FROM items i JOIN roots r ON r.id = i.root_id
     WHERE i.status = 'present' AND i.sha256 IS NOT NULL${clause}
     GROUP BY sha256, size
     HAVING copies >= 2
     ORDER BY (copies - 1) * size DESC, sha256 ASC`;
  const membersSql = (clause: string): string =>
    `SELECT i.rel_path AS relPath, i.size AS size, i.dev AS dev, i.ino AS ino, r.path AS rootPath
     FROM items i JOIN roots r ON r.id = i.root_id
     WHERE i.status = 'present' AND i.sha256 = ?${clause}
     ORDER BY r.path ASC, i.rel_path ASC`;

  const heads = (
    scanId === undefined
      ? store.db.prepare(headsSql('')).all()
      : store.db.prepare(headsSql(scoped)).all({ scanId })
  ) as GroupHeadRow[];
  if (heads.length === 0) return [];

  const members =
    scanId === undefined ? store.db.prepare(membersSql('')) : store.db.prepare(membersSql(scoped));
  return heads.map((head) => {
    const items = (
      scanId === undefined ? members.all(head.sha256) : members.all(head.sha256, { scanId })
    ) as DuplicateItem[];
    return {
      sha256: head.sha256,
      size: head.size,
      copies: head.copies,
      wastedBytes: (head.copies - 1) * head.size,
      items,
    };
  });
}