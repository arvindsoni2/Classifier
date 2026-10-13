/**
 * Phase 1 Task 4: metadata extractors (plan docs/11-Phase-1-Plan.md Task 4).
 *
 * Fixtures are generated in this file from byte-level builders — a tiny PDF
 * with an information dictionary, a minimal EPUB and DOCX built as ZIPs, a
 * short WAV with RIFF INFO tags — plus one checked-in JPEG that carries real
 * EXIF, because hand-building a valid APP1 segment would test my encoder
 * rather than the extractor. Nothing here touches a real home directory or a
 * real media library (AGENTS.md rule 3).
 *
 * Tests that need `ffprobe` or `pdfinfo` skip with a visible reason when the
 * tool is absent, as the plan requires.
 */
import { copyFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleScanHook } from '../../src/catalogue/bundles.js';
import { loadConfig } from '../../src/catalogue/config.js';
import { scan } from '../../src/catalogue/scanner.js';
import { openStore, type CatalogueStore } from '../../src/catalogue/store.js';
import {
  extractMetadata,
  metadataRows,
  type Extractor,
  type MetadataRunSummary,
} from '../../src/catalogue/metadata/index.js';
import { runTool } from '../../src/catalogue/metadata/proc.js';
import { makeDocxWithCoreProperties, makeEpub, makePdfWithInfo } from '../fixtures/documents.js';
import { makeWav } from '../fixtures/media.js';
import { makeFixture, type Fixture } from './fixtures.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const EXIF_JPEG = fileURLToPath(new URL('../fixtures/images/exif-photo.jpg', import.meta.url));

interface Scanned {
  store: CatalogueStore;
  scanId: number;
  summary: MetadataRunSummary;
}

/** Scans a fixture and runs the real extractor registry over it. */
async function scanFixture(fixture: Fixture, options: { extractors?: Extractor[]; timeoutMs?: number } = {}): Promise<Scanned> {
  const store = openStoreFor(fixture);
  const scanId = await scanOnly(fixture, store);
  const summary = await extractMetadata(store, scanId, options);
  return { store, scanId, summary };
}

/** Re-runs a scan over an existing store, for rescan tests. */
async function rescan(fixture: Fixture, store: CatalogueStore): Promise<number> {
  return scanOnly(fixture, store);
}

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
  const result = await scan(loadConfig(writeConfig(fixture)), store, { onDirectory: bundleScanHook(store) });
  return result.scanId;
}

/** One extractor row for a path, or undefined when nothing was recorded. */
function rowFor(store: CatalogueStore, relPath: string): ReturnType<typeof metadataRows>[number] | undefined {
  return metadataRows(store).find((row) => row.relPath === relPath);
}

/** An extractor that reports a fixed result and counts what it was asked to do. */
function fakeExtractor(overrides: Partial<Extractor> & { name: string }): Extractor & { calls: number; availableCalls: number } {
  const extractor = {
    version: 'fake@1.0.0',
    appliesTo: () => true,
    available: async () => true,
    extract: async () => ({ marker: 'fake' }),
    ...overrides,
    calls: 0,
    availableCalls: 0,
  } as Extractor & { calls: number; availableCalls: number };
  const baseExtract = extractor.extract;
  extractor.extract = async (absPath, signal) => {
    extractor.calls += 1;
    return baseExtract(absPath, signal);
  };
  const baseAvailable = extractor.available;
  extractor.available = async () => {
    extractor.availableCalls += 1;
    return baseAvailable();
  };
  return extractor;
}

describe('metadata extractors (Phase 1 Task 4)', () => {
  it('pdfinfo reports the document information dictionary', async (context) => {
    const available = await runTool('pdfinfo', ['-v'], { timeoutMs: 5000 }).catch(() => null);
    if (available === null || available.spawnFailed) {
      context.skip();
      return;
    }
    const fixture = makeFixture('metadata-pdf');
    fixture.put('report.pdf', makePdfWithInfo({ Title: 'Fixture Report', Author: 'A. Fixture', Subject: 'Testing', Keywords: 'pdf, catalogue' }, 2));
    const { store } = await scanFixture(fixture);

    const row = rowFor(store, 'report.pdf');
    expect(row?.extractor).toBe('pdfinfo');
    expect(row?.status).toBe('ok');
    expect(row?.fields).toMatchObject({
      title: 'Fixture Report',
      author: 'A. Fixture',
      subject: 'Testing',
      keywords: 'pdf, catalogue',
      pages: 2,
      encrypted: false,
    });
    // The version travels with every row, so a later extractor change is visible.
    expect(row?.extractorVersion).toMatch(/^pdfinfo@\d/);
  });

  it('ffprobe reports duration, codec and tags', async (context) => {
    const available = await runTool('ffprobe', ['-version'], { timeoutMs: 5000 }).catch(() => null);
    if (available === null || available.spawnFailed) {
      context.skip();
      return;
    }
    const fixture = makeFixture('metadata-wav');
    fixture.put('tone.wav', makeWav({ seconds: 1.5, title: 'Fixture Tone', artist: 'A Fixture' }));
    const { store } = await scanFixture(fixture);

    const row = rowFor(store, 'tone.wav');
    expect(row?.extractor).toBe('ffprobe');
    expect(row?.status).toBe('ok');
    expect(row?.fields).toMatchObject({ codec: 'pcm_s16le', sampleRate: 8000 });
    expect(Number(row?.fields.duration)).toBeCloseTo(1.5, 2);
    expect(row?.fields.tags).toMatchObject({ title: 'Fixture Tone', artist: 'A Fixture' });
  });

  it('exif keeps GPS out of the catalogue', async (context) => {
    const fixture = makeFixture('metadata-exif');
    copyFileSync(EXIF_JPEG, join(fixture.root, 'photo.jpg'));
    const { store } = await scanFixture(fixture);

    const row = rowFor(store, 'photo.jpg');
    expect(row?.extractor).toBe('exif');
    expect(row?.status).toBe('ok');
    expect(row?.fields).toMatchObject({ Make: 'Fixture Cameras', Model: 'Model One' });
    expect(String(row?.fields.DateTimeOriginal)).toContain('2024-03-11');
    expect(row?.fields.hasGps).toBe(true);
    // The fixture really does carry coordinates: the boolean survives, and the
    // field list is exactly the allowlist — no GPS key of any kind.
    expect(Object.keys(row?.fields ?? {}).sort()).toEqual([
      'DateTimeOriginal',
      'Make',
      'Model',
      'hasGps',
      'height',
      'width',
    ]);
    const serialised = JSON.stringify(row?.fields);
    expect(serialised).not.toMatch(/latitude|longitude/i);
    expect(serialised).not.toContain('51.5');
    void context;
  });

  it('epub reads the package document named by the container', async () => {
    const fixture = makeFixture('metadata-epub');
    fixture.put(
      'book.epub',
      makeEpub({
        title: 'A Synthetic Book',
        creator: 'An Author',
        subject: 'Testing',
        language: 'en',
        publisher: 'A Press',
        date: '2021-01-02',
      }),
    );
    // The OPF is not at the conventional path: the container must be followed.
    fixture.put('odd.epub', makeEpub({ title: 'Unconventional Layout', opfPath: 'EPUB/pkg.opf' }));
    const { store } = await scanFixture(fixture);

    const row = rowFor(store, 'book.epub');
    expect(row?.extractor).toBe('epub');
    expect(row?.status).toBe('ok');
    expect(row?.fields).toMatchObject({
      title: 'A Synthetic Book',
      creator: 'An Author',
      subject: 'Testing',
      language: 'en',
      publisher: 'A Press',
      date: '2021-01-02',
    });
    expect(rowFor(store, 'odd.epub')?.fields.title).toBe('Unconventional Layout');
  });

  it('office reads docProps/core.xml', async () => {
    const fixture = makeFixture('metadata-office');
    fixture.put(
      'report.docx',
      makeDocxWithCoreProperties(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
          'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">' +
          '<dc:title>Quarterly Report</dc:title><dc:creator>A. Fixture</dc:creator>' +
          '<dc:subject>Numbers</dc:subject><cp:keywords>report, q3</cp:keywords>' +
          '<dcterms:created xsi:type="dcterms:W3CDTF" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">2023-07-01T09:00:00Z</dcterms:created>' +
          '<dcterms:modified xsi:type="dcterms:W3CDTF" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">2023-07-02T11:30:00Z</dcterms:modified>' +
          '</cp:coreProperties>',
      ),
    );
    const { store } = await scanFixture(fixture);

    const row = rowFor(store, 'report.docx');
    expect(row?.extractor).toBe('office');
    expect(row?.status).toBe('ok');
    expect(row?.fields).toMatchObject({
      title: 'Quarterly Report',
      creator: 'A. Fixture',
      subject: 'Numbers',
      keywords: 'report, q3',
      created: '2023-07-01T09:00:00Z',
      modified: '2023-07-02T11:30:00Z',
    });
  });

  it('a malformed EPUB is failed and the other items still extract', async () => {
    const fixture = makeFixture('metadata-malformed');
    fixture.put('broken.epub', Buffer.from('this is not a ZIP archive at all'));
    fixture.put('intact.docx', makeDocxWithCoreProperties('<?xml version="1.0"?><cp:coreProperties><dc:title>Fine</dc:title></cp:coreProperties>'));
    const { store, summary } = await scanFixture(fixture);

    const broken = rowFor(store, 'broken.epub');
    expect(broken?.status).toBe('failed');
    expect(String(broken?.fields.error)).toMatch(/zip|archive|central/i);
    expect(broken?.extractor).toBe('epub');
    // One bad file does not stop the pass.
    expect(rowFor(store, 'intact.docx')?.status).toBe('ok');
    expect(summary.failed).toBe(1);
    expect(summary.ok).toBe(1);
  });

  it('a missing tool is unavailable once, not an error per file', async () => {
    const fixture = makeFixture('metadata-unavailable');
    fixture.put('a.docx', makeDocxWithCoreProperties('<?xml version="1.0"?><cp:coreProperties><dc:title>A</dc:title></cp:coreProperties>'));
    fixture.put('b.docx', makeDocxWithCoreProperties('<?xml version="1.0"?><cp:coreProperties><dc:title>B</dc:title></cp:coreProperties>'));
    const absent = fakeExtractor({
      name: 'absent',
      appliesTo: (kind, ext) => ext === 'docx',
      available: async () => false,
    });
    const { store } = await scanFixture(fixture, { extractors: [absent] });

    const rows = metadataRows(store).filter((row) => row.extractor === 'absent');
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'unavailable')).toBe(true);
    // Probed once for the whole scan, then reused for every item.
    expect(absent.availableCalls).toBe(1);
    expect(absent.calls).toBe(0);
  });

  it('a hung extraction is recorded as a timeout', async () => {
    const fixture = makeFixture('metadata-timeout');
    fixture.put('slow.pdf', makePdfWithInfo({ Title: 'Never read' }, 1));
    const hung = fakeExtractor({
      name: 'hung',
      appliesTo: (kind, ext) => ext === 'pdf',
      extract: (absPath, signal) =>
        new Promise((resolve, reject) => {
          // Settles only on abort: the runner's signal ends it.
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    });
    const { store, summary } = await scanFixture(fixture, { extractors: [hung], timeoutMs: 40 });

    expect(rowFor(store, 'slow.pdf')?.status).toBe('timeout');
    expect(summary.timeouts).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it('an extractor that ignores its signal still cannot hold the pass open', async () => {
    const fixture = makeFixture('metadata-timeout-stubborn');
    fixture.put('endless.pdf', makePdfWithInfo({ Title: 'Endless' }, 1));
    const stubborn = fakeExtractor({
      name: 'stubborn',
      appliesTo: (kind, ext) => ext === 'pdf',
      // Ignores the signal entirely and never settles.
      extract: () => new Promise<Record<string, unknown>>(() => {}),
    });
    const { store, summary } = await scanFixture(fixture, { extractors: [stubborn], timeoutMs: 40 });

    expect(rowFor(store, 'endless.pdf')?.status).toBe('timeout');
    expect(summary.timeouts).toBe(1);
  });

  it('extraction runs two at a time', async () => {
    const fixture = makeFixture('metadata-concurrency');
    for (let index = 1; index <= 6; index += 1) {
      fixture.put(`doc-${index}.docx`, makeDocxWithCoreProperties(`<?xml version="1.0"?><cp:coreProperties><dc:title>Doc ${index}</dc:title></cp:coreProperties>`));
    }
    let active = 0;
    let peak = 0;
    const slow = fakeExtractor({
      name: 'slow',
      appliesTo: (kind, ext) => ext === 'docx',
      extract: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return { done: true };
      },
    });
    await scanFixture(fixture, { extractors: [slow] });

    expect(slow.calls).toBe(6);
    expect(peak).toBe(2);
  });

  it('a ZIP entry above the inflate budget is refused', async () => {
    const fixture = makeFixture('metadata-zip-budget');
    // 21 MiB uncompressed in a tiny compressed entry: the classic zip bomb.
    fixture.put(
      'bomb.docx',
      makeDocxWithCoreProperties(`<?xml version="1.0"?><cp:coreProperties><dc:title>${'x'.repeat(21 * 1024 * 1024)}</dc:title></cp:coreProperties>`),
    );
    const { store } = await scanFixture(fixture);

    const row = rowFor(store, 'bomb.docx');
    expect(row?.status).toBe('failed');
    expect(String(row?.fields.error)).toMatch(/uncompressed|budget/i);
  });

  it('unchanged items keep their metadata and changed ones are extracted again', async () => {
    const fixture = makeFixture('metadata-rescan');
    fixture.put('one.epub', makeEpub({ title: 'First Title' }));
    fixture.put('two.epub', makeEpub({ title: 'Second Title' }));

    // The real registry, so the recorded fields are the ones a report reads.
    const first = await scanFixture(fixture);
    expect(first.summary.extracted).toBe(2);
    expect(first.summary.ok).toBe(2);
    expect(rowFor(first.store, 'one.epub')?.fields.title).toBe('First Title');

    // Nothing changed on disk, so the second pass does no work at all.
    const secondScanId = await rescan(fixture, first.store);
    const second = await extractMetadata(first.store, secondScanId);
    expect(second.extracted).toBe(0);
    expect(second.unchanged).toBe(2);
    expect(metadataRows(first.store)).toHaveLength(2);

    // A changed file loses its metadata and is extracted again with new values.
    fixture.put('one.epub', makeEpub({ title: 'Retitled' }));
    const thirdScanId = await rescan(fixture, first.store);
    const third = await extractMetadata(first.store, thirdScanId);
    expect(third.extracted).toBe(1);
    expect(third.unchanged).toBe(1);
    const changed = rowFor(first.store, 'one.epub');
    expect(changed?.fields.title).toBe('Retitled');
    expect(changed?.extractedScan).toBe(thirdScanId);
    // The untouched file keeps its original row, fields and scan id.
    expect(rowFor(first.store, 'two.epub')?.fields.title).toBe('Second Title');
    expect(rowFor(first.store, 'two.epub')?.extractedScan).toBe(first.scanId);
  });

  it('a bounded child tool cannot flood the catalogue', async () => {
    const result = await runTool(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(3 * 1024 * 1024))'],
      { timeoutMs: 10_000, maxOutputBytes: 1024 * 1024 },
    );
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBe(1024 * 1024);
    expect(result.truncated).toBe(true);
  });

  it('a child tool that overruns its deadline is killed', async () => {
    const started = Date.now();
    const result = await runTool(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('extraction is read only on the roots', async (context) => {
    const fixture = makeFixture('metadata-readonly');
    fixture.put('book.epub', makeEpub({ title: 'Read Only' }));
    fixture.put('report.docx', makeDocxWithCoreProperties('<?xml version="1.0"?><cp:coreProperties><dc:title>Read Only</dc:title></cp:coreProperties>'));
    fixture.put('tone.wav', makeWav({ seconds: 1, title: 'Read Only' }));
    copyFileSync(EXIF_JPEG, join(fixture.root, 'photo.jpg'));

    const before = snapshot(fixture.root);
    await scanFixture(fixture);
    expect(snapshot(fixture.root)).toEqual(before);
    void context;
  });
});

/** (path, size, mtime) for every entry under a directory, recursively. */
function snapshot(dir: string): Record<string, string> {
  const rows: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        rows[full] = 'dir';
        walk(full);
        continue;
      }
      const stat = statSync(full);
      rows[full] = `${stat.size}:${stat.mtimeMs}`;
    }
  };
  walk(dir);
  return rows;
}