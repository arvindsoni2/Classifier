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