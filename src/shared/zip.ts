/**
 * Bounded ZIP reading, shared by the extraction adapter and the catalogue's
 * `epub` and `office` metadata extractors (plan Tasks 3 and 4).
 *
 * This is the same forward-only reader the adapter has always used, moved here
 * so one implementation serves both callers. Its properties matter more than
 * its size:
 *
 *  - it never extracts an entry to disk and never executes anything inside the
 *    archive;
 *  - every inflate is bounded by an explicit uncompressed-byte budget, so a
 *    small file that claims a huge entry (a zip bomb) is refused rather than
 *    expanded;
 *  - ZIP64 entries, which would need 64-bit offsets to read safely, are refused
 *    rather than approximated.
 *
 * Only the two entries the catalogue needs are ever read: EPUB's OPF and
 * Office's `docProps/core.xml`. Nothing is enumerated into memory.
 */
import { inflateRawSync } from 'node:zlib';
import { type FileHandle } from 'node:fs/promises';
import { err, ok, type Result } from './result.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/**
 * Ceiling on one inflated entry (plan Task 4: "ZIP reads keep the existing
 * 20 MiB inflate budget"). Defined here, next to the check, so every caller —
 * the extraction adapter and both catalogue extractors — is bounded by the same
 * number instead of by its own copy of it.
 */
export const ZIP_INFLATE_BUDGET_BYTES = 20 * 1024 * 1024;

/** The central-directory facts needed to locate one entry's data. */
export interface ZipEntryRecord {
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

/** Locates `wanted` in the central directory, without inflating anything. */
export function findZipEntry(file: Buffer, wanted: string): Result<ZipEntryRecord> {
  const scanStart = Math.max(0, file.length - 65_557);
  let eocd = -1;
  for (let i = file.length - 22; i >= scanStart; i--) {
    if (file.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    return err('EXTRACTION_FAILED', 'malformed ZIP: end-of-central-directory record not found (truncated or not a ZIP)');
  }
  const entryCount = file.readUInt16LE(eocd + 10);
  let offset = file.readUInt32LE(eocd + 16);
  if (offset + 46 > file.length) {
    return err('EXTRACTION_FAILED', 'malformed ZIP: central directory offset outside the file');
  }
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > file.length || file.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      return err('EXTRACTION_FAILED', 'malformed ZIP: central directory entry truncated');
    }
    const method = file.readUInt16LE(offset + 10);
    const compressedSize = file.readUInt32LE(offset + 20);
    const uncompressedSize = file.readUInt32LE(offset + 24);
    const nameLength = file.readUInt16LE(offset + 28);
    const extraLength = file.readUInt16LE(offset + 30);
    const commentLength = file.readUInt16LE(offset + 32);
    const localOffset = file.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength > file.length) {
      return err('EXTRACTION_FAILED', 'malformed ZIP: central directory name truncated');
    }
    const name = file.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === wanted) {
      return ok({ method, compressedSize, uncompressedSize, localOffset });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return err('EXTRACTION_FAILED', `ZIP entry ${wanted} not found in the archive`);
}

/** Reads one entry's bytes, refusing anything above `budget` once inflated. */
export function readZipEntryData(file: Buffer, record: ZipEntryRecord, budget: number): Result<Buffer> {
  if (record.uncompressedSize === 0xffffffff || record.compressedSize === 0xffffffff) {
    return err('EXTRACTION_FAILED', 'unsupported ZIP64 entry');
  }
  if (record.uncompressedSize > budget) {
    return err(
      'EXTRACTION_FAILED',
      `uncompressed entry is ${record.uncompressedSize} bytes, above the ${budget}-byte budget; zip bomb refused`,
    );
  }
  if (record.localOffset + 30 > file.length || file.readUInt32LE(record.localOffset) !== LOCAL_SIGNATURE) {
    return err('EXTRACTION_FAILED', 'malformed ZIP: local header not found at the recorded offset');
  }
  const nameLength = file.readUInt16LE(record.localOffset + 26);
  const extraLength = file.readUInt16LE(record.localOffset + 28);
  const dataStart = record.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + record.compressedSize;
  if (dataEnd > file.length) {
    return err('EXTRACTION_FAILED', 'malformed ZIP: entry data runs past the end of the file');
  }
  const data = file.subarray(dataStart, dataEnd);
  if (record.method === 0) return ok(data);
  if (record.method === 8) {
    try {
      return ok(inflateRawSync(data, { maxOutputLength: budget }));
    } catch {
      return err('EXTRACTION_FAILED', 'malformed ZIP: deflate stream failed to decompress');
    }
  }
  return err('EXTRACTION_FAILED', `unsupported ZIP compression method ${record.method}`);
}

/** Locates and inflates one named entry within the budget. */
export function readZipEntry(file: Buffer, wanted: string, budget: number): Result<Buffer> {
  const record = findZipEntry(file, wanted);
  if (!record.ok) return record;
  return readZipEntryData(file, record.value, budget);
}

/** Read at most `length` bytes starting at `position`, from an open descriptor. */
async function readAt(
  handle: FileHandle,
  position: number,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    if (signal?.aborted === true) throw new Error('ZIP read aborted');
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/**
 * Reads one named entry from a ZIP on disk by seeking, without loading the whole
 * file into memory. Only the end-of-central-directory record, the central
 * directory and the entry itself are read — a 64 MiB archive with a small
 * metadata entry costs a handful of bounded reads, not 64 MiB of memory.
 *
 * ZIP64 archives are refused outright; this reader does not approximate them.
 */
export async function readZipEntryFromHandle(
  handle: FileHandle,
  wanted: string,
  budget: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const { size } = await handle.stat({ bigint: true });
  const fileSize = Number(size);
  if (fileSize === 0) {
    throw new Error('malformed ZIP: empty file');
  }

  // The end-of-central-directory record is within the last 65,557 bytes.
  const scanStart = Math.max(0, fileSize - 65_557);
  const tail = await readAt(handle, scanStart, fileSize - scanStart, signal);
  let eocd = -1;
  let eocdIndex = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = scanStart + i;
      eocdIndex = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('malformed ZIP: end-of-central-directory record not found (truncated or not a ZIP)');
  }
  const entryCount = tail.readUInt16LE(eocdIndex + 10);
  if (entryCount === 0xffff) {
    throw new Error('unsupported ZIP64 entry');
  }
  const centralOffset = tail.readUInt32LE(eocdIndex + 16);
  if (centralOffset === 0xffffffff) {
    throw new Error('unsupported ZIP64 entry');
  }

  // Walk the central directory looking for `wanted`.
  let record: ZipEntryRecord | null = null;
  let offset = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    const header = await readAt(handle, offset, 46, signal);
    if (header.length < 46 || header.readUInt32LE(0) !== CENTRAL_SIGNATURE) {
      throw new Error('malformed ZIP: central directory entry truncated');
    }
    const method = header.readUInt16LE(10);
    const compressedSize = header.readUInt32LE(20);
    const uncompressedSize = header.readUInt32LE(24);
    const nameLength = header.readUInt16LE(28);
    const extraLength = header.readUInt16LE(30);
    const commentLength = header.readUInt16LE(32);
    const localOffset = header.readUInt32LE(42);
    if (localOffset === 0xffffffff || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error('unsupported ZIP64 entry');
    }
    if (offset + 46 + nameLength > fileSize) {
      throw new Error('malformed ZIP: central directory name truncated');
    }
    const name = (await readAt(handle, offset + 46, nameLength, signal)).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
    if (name !== wanted) continue;
    record = { method, compressedSize, uncompressedSize, localOffset };
    break;
  }
  if (record === null) {
    throw new Error(`ZIP entry ${wanted} not found in the archive`);
  }

  if (record.uncompressedSize > budget) {
    throw new Error(
      `uncompressed entry is ${record.uncompressedSize} bytes, above the ${budget}-byte budget; zip bomb refused`,
    );
  }

  // Read the entry's data from its local header.
  const local = await readAt(handle, record.localOffset, 30, signal);
  if (local.length < 30 || local.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new Error('malformed ZIP: local header not found at the recorded offset');
  }
  const localNameLength = local.readUInt16LE(26);
  const localExtraLength = local.readUInt16LE(28);
  const dataStart = record.localOffset + 30 + localNameLength + localExtraLength;
  if (dataStart + record.compressedSize > fileSize) {
    throw new Error('malformed ZIP: entry data runs past the end of the file');
  }
  const data = await readAt(handle, dataStart, record.compressedSize, signal);
  if (record.method === 0) return data;
  if (record.method === 8) {
    try {
      return inflateRawSync(data, { maxOutputLength: budget });
    } catch {
      throw new Error('malformed ZIP: deflate stream failed to decompress');
    }
  }
  throw new Error(`unsupported ZIP compression method ${record.method}`);
}