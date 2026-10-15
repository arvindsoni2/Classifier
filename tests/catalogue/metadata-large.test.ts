/**
 * Phase 1 Task 8 item 4: large EPUB and Office files are read by seeking.
 *
 * epub.ts and office.ts no longer load the whole file: they read the ZIP
 * end-of-central-directory and central directory by seeking, then only the
 * entries they need. A 64 MiB+ EPUB therefore extracts its metadata without
 * ever reading its padding.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractMetadata, metadataRows } from '../../src/catalogue/metadata/index.js';
import { loadConfig } from '../../src/catalogue/config.js';
import { epubExtractor } from '../../src/catalogue/metadata/epub.js';
import { officeExtractor } from '../../src/catalogue/metadata/office.js';
import { scan } from '../../src/catalogue/scanner.js';
import { openStore, type CatalogueStore } from '../../src/catalogue/store.js';
import { makeFixture, type Fixture } from './fixtures.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function openStoreFor(fixture: Fixture): CatalogueStore {
  const store = openStore(join(fixture.parent, 'data'));
  cleanups.push(() => store.close());
  return store;
}

function writeConfig(fixture: Fixture): string {
  const configPath = join(fixture.parent, 'catalogue.json');
  const dataDir = join(fixture.parent, 'data');
  writeFileSync(configPath, JSON.stringify({ roots: [fixture.root], dataDir }), 'utf8');
  return configPath;
}

async function scanOnly(fixture: Fixture, store: CatalogueStore): Promise<number> {
  const result = await scan(loadConfig(writeConfig(fixture)), store, {});
  return result.scanId;
}

function rowFor(store: CatalogueStore, relPath: string) {
  return metadataRows(store).find((row) => row.relPath === relPath);
}

/** Builds a ZIP (stored entries only) from `{ name, data }` pairs. */
function makeZip(entries: { name: string; data: Buffer }[]): Buffer {
  let localOffset = 0;
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  const now = new Date();
  const dosTime =
    ((now.getHours() << 11) | (now.getMinutes() << 5) | now.getSeconds() / 2) << 16 |
    ((now.getFullYear() - 1980) << 9 | (now.getMonth() + 1) << 5 | now.getDate());
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(dosTime & 0xffff, 10); // mod time
    local.writeUInt16LE(dosTime >>> 16, 12); // mod date
    local.writeUInt32LE(0, 14); // crc32
    local.writeUInt32LE(entry.data.length, 18); // compressed size
    local.writeUInt32LE(entry.data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localParts.push(local);
    localParts.push(name);
    localParts.push(entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method: stored
    central.writeUInt16LE(dosTime & 0xffff, 12); // mod time
    central.writeUInt16LE(dosTime >>> 16, 14); // mod date
    central.writeUInt32LE(0, 16); // crc32
    central.writeUInt32LE(entry.data.length, 20); // compressed size
    central.writeUInt32LE(entry.data.length, 24); // uncompressed size
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(localOffset, 42); // local header offset
    centralParts.push(central);
    centralParts.push(name);
    localOffset += 30 + name.length + entry.data.length;
  }
  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // disk start
  eocd.writeUInt16LE(entries.length, 8); // entries on disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDir.length, 12); // central directory size
  eocd.writeUInt32LE(localOffset, 16); // central directory offset
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...localParts, centralDir, eocd]);
}

const FILLER_BYTES = 64 * 1024 * 1024; // above MAX_EXTRACTOR_INPUT_BYTES

describe('large ZIP-based metadata (Task 8 item 4)', () => {
  it('an EPUB padded past 64 MiB yields its title and author without loading the file', async () => {
    const container =
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
    const opf =
      '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>A Synthetic Book</dc:title><dc:creator>An Author</dc:creator></metadata></package>';
    const fixture = makeFixture('large-epub');
    fixture.put('book.epub', makeZip([
      { name: 'mimetype', data: Buffer.from('application/epub+zip') },
      { name: 'META-INF/container.xml', data: Buffer.from(container) },
      { name: 'OEBPS/content.opf', data: Buffer.from(opf) },
      // A stored filler entry pushes the archive past the 64 MiB extractor limit.
      { name: 'filler.bin', data: Buffer.alloc(FILLER_BYTES) },
    ]));

    const store = openStoreFor(fixture);
    const scanId = await scanOnly(fixture, store);
    await extractMetadata(store, scanId);

    const row = rowFor(store, 'book.epub');
    expect(row?.extractor).toBe('epub');
    expect(row?.status).toBe('ok');
    expect(row?.fields.title).toBe('A Synthetic Book');
    expect(row?.fields.creator).toBe('An Author');
  });

  it('a padded DOCX yields its core properties without loading the file', async () => {
    const core =
      '<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"><dc:title>Big Report</dc:title><dc:creator>A. Fixture</dc:creator></cp:coreProperties>';
    const fixture = makeFixture('large-docx');
    fixture.put('report.docx', makeZip([
      { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types/>') },
      { name: 'docProps/core.xml', data: Buffer.from(core) },
      { name: 'filler.bin', data: Buffer.alloc(FILLER_BYTES) },
    ]));

    const fields = await officeExtractor.extract(join(fixture.root, 'report.docx'), new AbortController().signal);
    expect(fields.title).toBe('Big Report');
    expect(fields.creator).toBe('A. Fixture');
  });

  it('a ZIP64 archive is refused with a clear failure', async () => {
    const fixture = makeFixture('zip64');
    const zip = makeZip([
      { name: 'META-INF/container.xml', data: Buffer.from('<container/>') },
    ]);
    // Corrupt the EOCD central-directory offset to 0xffffffff (ZIP64 signal).
    const corrupted = Buffer.concat([zip.subarray(0, zip.length - 6), Buffer.from([0xff, 0xff, 0xff, 0xff]), zip.subarray(zip.length - 2)]);
    fixture.put('weird.epub', corrupted);

    let thrown: Error | undefined;
    try {
      await epubExtractor.extract(join(fixture.root, 'weird.epub'), new AbortController().signal);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.message).toMatch(/zip64/i);
  });
});
