/**
 * Bounded file hashing (plan Task 2 rules 2–4).
 *
 * Both hashes are computed from an already-opened read-only descriptor, never
 * from a path, and never by re-opening. A fixed-size buffer streams every
 * read, so no hash ever holds a whole file in memory. Before and after each
 * hash the descriptor is fstat'd: if the size or mtime moved, the file was
 * being written while read and the outcome is `CHANGED_DURING_HASH` — the
 * caller records that in `scan_errors` and leaves the item unhashed.
 */
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';

/** Byte length of each partial-hash window (first/last 64 KiB). */
export const PARTIAL_WINDOW_BYTES = 64 * 1024;

/** Streaming read granularity; also the peak memory any hash uses. */
const STREAM_CHUNK_BYTES = 1024 * 1024;

export type HashOutcome =
  | { ok: true; hash: string }
  | { ok: false; code: 'CHANGED_DURING_HASH'; detail: string };

/** Hashing seam. `computeHashes` accepts an alternative for tests. */
export interface Hasher {
  /**
   * SHA-256 over `size || first 64 KiB || last 64 KiB`, with the whole file
   * in place of the two windows when it is at most 128 KiB.
   */
  partial(handle: FileHandle, size: number): Promise<HashOutcome>;
  /** SHA-256 over the whole file, streamed. */
  full(handle: FileHandle): Promise<HashOutcome>;
}

interface StatMoment {
  size: bigint;
  mtimeNs: bigint;
}

async function moment(handle: FileHandle): Promise<StatMoment> {
  const stat = await handle.stat({ bigint: true });
  return { size: stat.size, mtimeNs: stat.mtimeNs };
}

function changedDuringHash(before: StatMoment, after: StatMoment): HashOutcome {
  return {
    ok: false,
    code: 'CHANGED_DURING_HASH',
    detail: `file changed while being read (size ${before.size} -> ${after.size}, mtimeNs ${before.mtimeNs} -> ${after.mtimeNs}); hash discarded`,
  };
}

/** Hashes `length` bytes starting at `start`, reading in fixed chunks. */
async function hashRange(
  handle: FileHandle,
  hash: ReturnType<typeof createHash>,
  start: number,
  length: number,
): Promise<void> {
  const buffer = Buffer.alloc(Math.min(STREAM_CHUNK_BYTES, Math.max(length, 1)));
  let position = start;
  let remaining = length;
  while (remaining > 0) {
    const want = Math.min(buffer.length, remaining);
    const { bytesRead } = await handle.read(buffer, 0, want, position);
    if (bytesRead === 0) break; // Shorter than the catalogue believed: hash what is there.
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
    remaining -= bytesRead;
  }
}

/** Reads from the descriptor, so a swapped path can never be hashed by mistake. */
export function createHasher(): Hasher {
  return {
    async partial(handle, size) {
      const before = await moment(handle);
      const hash = createHash('sha256');
      // The decimal size prefix makes window-equal files of different sizes
      // hash differently before any full hash is spent on them.
      hash.update(size.toString());
      if (size <= 2 * PARTIAL_WINDOW_BYTES) {
        await hashRange(handle, hash, 0, size);
      } else {
        await hashRange(handle, hash, 0, PARTIAL_WINDOW_BYTES);
        await hashRange(handle, hash, size - PARTIAL_WINDOW_BYTES, PARTIAL_WINDOW_BYTES);
      }
      const after = await moment(handle);
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
        return changedDuringHash(before, after);
      }
      return { ok: true, hash: hash.digest('hex') };
    },

    async full(handle) {
      const before = await moment(handle);
      const hash = createHash('sha256');
      await hashRange(handle, hash, 0, Number(before.size));
      const after = await moment(handle);
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
        return changedDuringHash(before, after);
      }
      return { ok: true, hash: hash.digest('hex') };
    },
  };
}