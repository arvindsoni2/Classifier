/**
 * Bounded file reads for the in-process extractors (plan Task 4).
 *
 * `exif`, `epub` and `office` need the whole file in memory, unlike `ffprobe`
 * and `pdfinfo`, which read the file themselves. Reading it here rather than
 * letting a library open a path keeps three properties the hashing pass already
 * relies on: the bytes come from one descriptor, a file that is too large is
 * refused instead of exhausting memory, and a file that changes while it is
 * being read is refused rather than half-parsed.
 */
import { open } from 'node:fs/promises';

/** Default ceiling for a file an extractor may hold in memory. */
export const MAX_EXTRACTOR_INPUT_BYTES = 64 * 1024 * 1024;

const CHUNK_BYTES = 1024 * 1024;

interface StatMoment {
  size: bigint;
  mtimeNs: bigint;
}

/**
 * Reads `absPath` into memory, refusing anything above `maxBytes` and anything
 * that changes size or mtime between the two stats.
 */
export async function readFileBounded(
  absPath: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const handle = await open(absPath, 'r');
  try {
    const before = await statOf(handle);
    if (before.size > BigInt(maxBytes)) {
      throw new Error(`file is ${before.size} bytes, above the ${maxBytes}-byte extractor limit`);
    }
    if (signal.aborted) throw new Error('extraction aborted before the file was read');

    const buffer = Buffer.alloc(Number(before.size));
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, Math.min(CHUNK_BYTES, buffer.length - filled), filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }

    const after = await statOf(handle);
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new Error('file changed while it was being read; extraction abandoned');
    }
    return filled === buffer.length ? buffer : buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

async function statOf(handle: import('node:fs/promises').FileHandle): Promise<StatMoment> {
  const stat = await handle.stat({ bigint: true });
  return { size: stat.size, mtimeNs: stat.mtimeNs };
}