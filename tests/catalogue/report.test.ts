/**
 * Phase 1 Task 5: reports (plan docs/11-Phase-1-Plan.md Task 5).
 *
 * A fixture catalogue with known contents is scanned, hashed and classified,
 * then reported. The assertions are on the numbers a reviewer would check
 * against `find`: how many files, how many bytes, which kinds, which bundles,
 * how much space duplicates waste. Everything runs on synthetic fixture trees
 * (AGENTS.md rule 3), and the report is asserted to land under the data
 * directory with nothing written inside the root.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleScanHook, detectBundles } from '../../src/catalogue/bundles.js';
import { loadConfig, validateConfig, type CatalogueConfig } from '../../src/catalogue/config.js';
import { computeHashes } from '../../src/catalogue/dedupe.js';
import { reportSummary, writeReport, type ReportResult } from '../../src/catalogue/report.js';
import { scan } from '../../src/catalogue/scanner.js';
import { openStore, type CatalogueStore } from '../../src/catalogue/store.js';
import { makeFixture, type Fixture } from './fixtures.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const DUP_PAYLOAD = 'the same bytes twice\n';

/** A fixture whose catalogue contents are known exactly, so totals can be asserted. */
function buildFixture(label: string): Fixture {
  const fixture = makeFixture(label);
  // Two identical files: one duplicate group, one wasted copy.
  fixture.put('dup-a.txt', DUP_PAYLOAD);
  fixture.put('dup-b.txt', DUP_PAYLOAD);
  fixture.put('unique.txt', 'bytes of their own\n');
  // An album: three numbered tracks.
  fixture.put('great-album/01 opener.mp3', 'first track bytes\n');
  fixture.put('great-album/02 middle.mp3', 'second track bytes\n');
  fixture.put('great-album/03 closer.mp3', 'third track bytes\n');
  // An extracted archive beside its own zip.
  fixture.put('holiday-pics.zip', 'not a real zip, only the extension matters\n');
  fixture.put('holiday-pics/one.jpg', 'first photo bytes\n');
  fixture.put('holiday-pics/two.jpg', 'second photo bytes\n');
  fixture.put('holiday-pics/three.jpg', 'third photo bytes\n');
  // A download in flight.
  fixture.put('partial.crdownload', 'half a file');
  // A code project: its contents are never catalogued.
  fixture.put('app/pyproject.toml', '[project]\nname = "app"\n');
  fixture.put('app/main.py', 'print("hi")\n');
  return fixture;
}

interface Reported {
  store: CatalogueStore;
  fixture: Fixture;
  scanId: number;
  report: ReportResult;
  summary: ReturnType<typeof parseSummary>;
}

function parseSummary(report: ReportResult): Record<string, unknown> {
  return JSON.parse(readFileSync(join(report.dir, 'summary.json'), 'utf8')) as Record<string, unknown>;
}

async function reportFixture(fixture: Fixture): Promise<Reported> {
  const dataDir = join(fixture.parent, 'data');
  const store = openStore(dataDir);
  cleanups.push(() => store.close());
  const configPath = join(fixture.parent, 'catalogue.json');
  writeFileSync(configPath, JSON.stringify({ roots: [fixture.root], dataDir }), 'utf8');

  const result = await scan(loadConfig(configPath), store, { onDirectory: bundleScanHook(store) });
  await computeHashes(store, result.scanId);
  detectBundles(store, result.scanId);
  const report = writeReport(store, result.scanId, dataDir);
  return { store, fixture, scanId: result.scanId, report, summary: parseSummary(report) };
}

/** Splits one CSV file into rows of raw fields, honouring quoted newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
        continue;
      }
      field += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    if (char === '\r') continue;
    field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe('catalogue report (Phase 1 Task 5)', () => {
  it('reports the totals a reviewer would check against find', async () => {
    const { report, summary, scanId } = await reportFixture(buildFixture('report-totals'));

    expect(report.dir).toMatch(new RegExp(`/reports/${scanId}-\\d{8}-\\d{4}$`));
    expect(report.files.sort()).toEqual([
      'bundles.csv',
      'duplicates.csv',
      'errors.csv',
      'metadata_failures.csv',
      'summary.json',
      'summary.md',
    ]);

    const scanSection = summary.scan as Record<string, number | string>;
    // 11 files: 8 plain + 3 album tracks, minus the 1 inside the code project
    // that was never catalogued. One of them is incomplete, not present.
    expect(scanSection.filesSeen).toBe(11);
    expect(scanSection.status).toBe('done');
    expect(typeof scanSection.durationMs).toBe('number');

    const roots = summary.roots as { path: string; files: number; bytes: number }[];
    expect(roots).toHaveLength(1);
    expect(roots[0]?.files).toBe(11);

    const kinds = new Map(
      (summary.kinds as { kind: string; files: number; bytes: number }[]).map((row) => [row.kind, row.files]),
    );
    // 3 documents (dup-a, dup-b, unique), 3 audio, 1 archive, 3 images, and the
    // half-downloaded file, whose extension is not a known kind. The two files
    // inside the code project were never catalogued at all.
    expect(kinds.get('document')).toBe(3);
    expect(kinds.get('audio')).toBe(3);
    expect(kinds.get('image')).toBe(3);
    expect(kinds.get('archive')).toBe(1);
    expect(kinds.get('other')).toBe(1);

    const duplicates = summary.duplicates as {
      groups: number;
      wastedBytes: number;
      largest: { sha256: string; copies: number; wastedBytes: number }[];
    };
    expect(duplicates.groups).toBe(1);
    expect(duplicates.wastedBytes).toBe(Buffer.byteLength(DUP_PAYLOAD));
    expect(duplicates.largest[0]?.copies).toBe(2);

    const bundles = summary.bundles as {
      total: number;
      byType: { type: string; count: number }[];
    };
    expect(bundles.total).toBe(3);
    expect(new Set(bundles.byType.map((row) => row.type))).toEqual(
      new Set(['album', 'extracted_archive', 'code_project']),
    );

    const incomplete = summary.incomplete as { path: string }[];
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]?.path.endsWith('/partial.crdownload')).toBe(true);

    const largest = summary.largestFiles as { path: string; size: number }[];
    expect(largest).toHaveLength(11);
    // Sorted by size, largest first.
    const sizes = largest.map((row) => row.size);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
  });

  it('keeps only the largest files the plan asks for', async () => {
    const fixture = makeFixture('report-largest-cap');
    // 25 files of known sizes, so the 20-row cap can be told from "all".
    for (let index = 1; index <= 25; index += 1) {
      fixture.put(`file-${String(index).padStart(2, '0')}.txt`, 'x'.repeat(index));
    }
    const { summary } = await reportFixture(fixture);

    const largest = summary.largestFiles as { path: string; size: number }[];
    expect(largest).toHaveLength(20);
    // The five smallest are the ones dropped, so the biggest is file-25.
    expect(largest[0]?.path.endsWith('file-25.txt')).toBe(true);
    expect(largest[0]?.size).toBe(25);
    expect(largest[19]?.size).toBe(6);
    // summary.json still counts every file, not just the ones listed.
    expect((summary.scan as { filesSeen: number }).filesSeen).toBe(25);
  });

  it('summary.md carries the same numbers in prose and tables', async () => {
    const { report } = await reportFixture(buildFixture('report-markdown'));
    const markdown = readFileSync(join(report.dir, 'summary.md'), 'utf8');

    expect(markdown).toMatch(/^# Catalogue summary/m);
    expect(markdown).toMatch(/## Totals per root/);
    expect(markdown).toMatch(/## Counts per kind/);
    expect(markdown).toMatch(/## Bundles/);
    expect(markdown).toMatch(/## Largest files/);
    expect(markdown).toMatch(/## Duplicate groups/);
    expect(markdown).toMatch(/## Incomplete files/);
    expect(markdown).toMatch(/## Errors by code/);
    expect(markdown).toMatch(/11 files/);
    expect(markdown).toMatch(new RegExp(`wasted ${Buffer.byteLength(DUP_PAYLOAD)} bytes`));
    expect(markdown).toContain('great-album');
    expect(markdown).toContain('partial.crdownload');
    // The duration and hashing figures the plan asks for.
    expect(markdown).toMatch(/Duration:[\s\S]*?\d/);
    expect(markdown).toMatch(/Files hashed:/);
  });

  it('duplicates.csv lists every member of every group', async () => {
    const { report } = await reportFixture(buildFixture('report-duplicates'));
    const rows = parseCsv(readFileSync(join(report.dir, 'duplicates.csv'), 'utf8'));

    expect(rows[0]).toEqual(['group', 'sha256', 'size', 'wasted_bytes', 'root', 'rel_path', 'mtime', 'bundle_type']);
    // One group, two members.
    expect(rows).toHaveLength(3);
    expect(rows[1]?.[0]).toBe('1');
    expect(rows[2]?.[0]).toBe('1');
    expect(rows[1]?.[1]).toBe(rows[2]?.[1]);
    expect(rows[1]?.[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[1]?.[2]).toBe(String(Buffer.byteLength(DUP_PAYLOAD)));
    expect(rows[1]?.[3]).toBe(String(Buffer.byteLength(DUP_PAYLOAD)));
    expect(rows.slice(1).map((row) => row[5]).sort()).toEqual(['dup-a.txt', 'dup-b.txt']);
    expect(rows[1]?.[6]).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it('bundles.csv reports type, members and parent', async () => {
    const { report } = await reportFixture(buildFixture('report-bundles'));
    const rows = parseCsv(readFileSync(join(report.dir, 'bundles.csv'), 'utf8'));

    expect(rows[0]).toEqual(['type', 'root', 'rel_path', 'members', 'total_size', 'rule', 'parent']);
    const byPath = new Map(rows.slice(1).map((row) => [row[2], row]));
    expect([...byPath.keys()].sort()).toEqual(['app', 'great-album', 'holiday-pics']);
    expect(byPath.get('great-album')?.[0]).toBe('album');
    expect(byPath.get('great-album')?.[3]).toBe('3');
    expect(Number(byPath.get('great-album')?.[4])).toBeGreaterThan(0);
    expect(byPath.get('great-album')?.[5]).toMatch(/track number/);
    // A walk-stopping bundle has no members and no parent.
    expect(byPath.get('app')?.[0]).toBe('code_project');
    expect(byPath.get('app')?.[3]).toBe('');
    expect(byPath.get('app')?.[4]).toBe('');
    expect(byPath.get('app')?.[6]).toBe('');
  });

  it('reports only what that one scan saw', async () => {
  // Two scans of two different roots into one catalogue. The second report must
  // describe the second scan alone: the first root's files and its bundle are
  // still in the database, and must not leak into it.
  const fixture = makeFixture('report-scan-scope');
  fixture.put('one/notes.txt', 'in the first root\n');
  fixture.put('two/album/01 one.mp3', 'first track bytes\n');
  fixture.put('two/album/02 two.mp3', 'second track bytes\n');
  fixture.put('two/album/03 three.mp3', 'third track bytes\n');

  const dataDir = join(fixture.parent, 'data');
  const store = openStore(dataDir);
  cleanups.push(() => store.close());
  const configFor = (root: string): CatalogueConfig => validateConfig({ roots: [root], dataDir });

  const first = await scan(configFor(join(fixture.root, 'one')), store, {
    onDirectory: bundleScanHook(store),
  });
  await computeHashes(store, first.scanId);
  detectBundles(store, first.scanId);
  const second = await scan(configFor(join(fixture.root, 'two')), store, {
    onDirectory: bundleScanHook(store),
  });
  detectBundles(store, second.scanId);

  const firstReport = reportSummary(store, first.scanId);
  expect(firstReport.scan.filesSeen).toBe(1);
  expect(firstReport.roots.map((root) => root.path)).toEqual([join(fixture.root, 'one')]);
  expect(firstReport.bundles.total).toBe(0);

  const secondReport = reportSummary(store, second.scanId);
  expect(secondReport.scan.filesSeen).toBe(3);
  expect(secondReport.roots.map((root) => root.path)).toEqual([join(fixture.root, 'two')]);
  // The album is the only bundle, and it belongs to this scan alone.
  expect(secondReport.bundles.total).toBe(1);
  expect(secondReport.bundles.byType.map((row) => row.type)).toEqual(['album']);
  expect(secondReport.bundles.largest[0]?.path).toBe(`${join(fixture.root, 'two')}/album`);
});

  it('keeps bundles in historical reports across a rescan (Task 8 item 5)', async () => {
    const fixture = makeFixture('report-historical-bundles');
    fixture.put('great-album/01 one.mp3', 'first track bytes\n');
    fixture.put('great-album/02 two.mp3', 'second track bytes\n');
    fixture.put('great-album/03 three.mp3', 'third track bytes\n');
    const dataDir = join(fixture.parent, 'data');
    const store = openStore(dataDir);
    cleanups.push(() => store.close());
    const configPath = join(fixture.parent, 'catalogue.json');
    writeFileSync(
      configPath,
      JSON.stringify({ roots: [fixture.root], dataDir }),
      'utf8',
    );
    const config = loadConfig(configPath);

    const first = await scan(config, store, { onDirectory: bundleScanHook(store) });
    detectBundles(store, first.scanId);
    const firstReport = reportSummary(store, first.scanId);
    expect(firstReport.bundles.total).toBe(1);
    const firstBundle = firstReport.bundles.largest[0];
    expect(firstBundle?.path).toBe(`${fixture.root}/great-album`);

    // Rescan: nothing changed, so the bundle is detected again and its
    // last_seen_scan moves forward while first_seen_scan stays put.
    const second = await scan(config, store, { onDirectory: bundleScanHook(store) });
    detectBundles(store, second.scanId);
    const rows = store.db
      .prepare(
        'SELECT first_seen_scan, last_seen_scan FROM bundles WHERE rel_path = ?',
      )
      .all('great-album') as { first_seen_scan: number; last_seen_scan: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.first_seen_scan).toBe(first.scanId);
    expect(rows[0]?.last_seen_scan).toBe(second.scanId);

    // The first report still lists the bundle: first_seen_scan <= 1 <= last_seen_scan.
    const historical = reportSummary(store, first.scanId);
    expect(historical.bundles.total).toBe(1);
    expect(historical.bundles.largest[0]?.path).toBe(`${fixture.root}/great-album`);
  });
});