/**
 * Phase 1 Task 5 + Task 8: individual report files.
 *
 * Assertions on the concrete files a report writes: `errors.csv`, the new
 * `metadata_failures.csv`, the Markdown and JSON summaries, and the report
 * directory placement. Everything runs on synthetic fixture trees
 * (AGENTS.md rule 3).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleScanHook, detectBundles } from '../../src/catalogue/bundles.js';
import { loadConfig } from '../../src/catalogue/config.js';
import { computeHashes } from '../../src/catalogue/dedupe.js';
import { extractMetadata } from '../../src/catalogue/metadata/index.js';
import { runTool } from '../../src/catalogue/metadata/proc.js';
import { latestFinishedScan, reportSummary, writeReport, type ReportResult } from '../../src/catalogue/report.js';
import { scan } from '../../src/catalogue/scanner.js';
import { openStore, type CatalogueStore } from '../../src/catalogue/store.js';
import { makeFixture, type Fixture } from './fixtures.js';
import { makeDocxWithCoreProperties, makePdfWithInfo } from '../fixtures/documents.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const DUP_PAYLOAD = 'the same bytes twice\n';

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

async function reportFixture(fixture: Fixture): Promise<{ store: CatalogueStore; scanId: number; report: ReportResult }> {
  const dataDir = join(fixture.parent, 'data');
  const store = openStore(dataDir);
  cleanups.push(() => store.close());
  const configPath = join(fixture.parent, 'catalogue.json');
  writeFileSync(configPath, JSON.stringify({ roots: [fixture.root], dataDir }), 'utf8');

  const result = await scan(loadConfig(configPath), store, { onDirectory: bundleScanHook(store) });
  await computeHashes(store, result.scanId);
  detectBundles(store, result.scanId);
  const report = writeReport(store, result.scanId, dataDir);
  return { store, scanId: result.scanId, report };
}

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

describe('report files (Phase 1 Task 5 + Task 8)', () => {
  it('errors.csv lists the scan errors this scan recorded', async (context) => {
    const fixture = makeFixture('report-files-errors');
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      // chmod 000 does not stop root, so the unreadable-directory case cannot
      // be staged honestly; the header and the empty-report path are covered.
      context.skip();
      return;
    }
    const unreadable = join(fixture.root, 'locked');
    mkdirSync(unreadable, { recursive: true });
    writeFileSync(join(unreadable, 'hidden.txt'), 'unreadable\n');
    chmodSync(unreadable, 0o000);
    const restore = (): void => chmodSync(unreadable, 0o700);
    cleanups.push(restore);

    const { report, store, scanId } = await reportFixture(fixture);
    restore();

    const rows = parseCsv(readFileSync(join(report.dir, 'errors.csv'), 'utf8'));
    expect(rows[0]).toEqual(['root', 'rel_path', 'code', 'message']);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.[1]).toBe('locked');
    expect(rows[1]?.[2]).toBe('EACCES');
    const summary = reportSummary(store, scanId);
    const byCode = summary.errors as { code: string; count: number }[];
    expect(byCode).toEqual([{ code: 'EACCES', count: 1 }]);
  });

  it('errors.csv has its header when a scan had no errors', async () => {
    const fixture = makeFixture('report-files-no-errors');
    const { report } = await reportFixture(fixture);
    const text = readFileSync(join(report.dir, 'errors.csv'), 'utf8');
    expect(text.trim()).toBe('root,rel_path,code,message');
    const markdown = readFileSync(join(report.dir, 'summary.md'), 'utf8');
    expect(markdown).toMatch(/## Errors by code[\s\S]*?(none|_No errors_)/i);
  });

  // Task 8 item 1: metadata failures get their own file, separate from scan errors.
  it('metadata_failures.csv lists every failed extraction with its error', async () => {
    const fixture = makeFixture('report-files-metadata-failures');
    fixture.put('broken.epub', Buffer.from('this is not a ZIP archive at all'));
    fixture.put(
      'intact.docx',
      makeDocxWithCoreProperties('<?xml version="1.0"?><cp:coreProperties><dc:title>Fine</dc:title></cp:coreProperties>'),
    );
    const { store, scanId } = await reportFixture(fixture);
    await extractMetadata(store, scanId);
    const dataDir = join(fixture.parent, 'data');
    const report = writeReport(store, scanId, dataDir);

    const rows = parseCsv(readFileSync(join(report.dir, 'metadata_failures.csv'), 'utf8'));
    expect(rows[0]).toEqual(['root', 'rel_path', 'extractor', 'status', 'error']);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.[1]).toBe('broken.epub');
    expect(rows[1]?.[2]).toBe('epub');
    expect(rows[1]?.[3]).toBe('failed');
    expect(rows[1]?.[4]).toMatch(/zip|archive|central/i);
    // The intact neighbour has no failure row.
    expect(rows[1]?.[0]).toBe(fixture.root);
  });

  it('metadata_failures.csv has its header when nothing failed', async () => {
    const fixture = makeFixture('report-files-metadata-none');
    fixture.put('notes.txt', 'plain text\n');
    const { store, scanId } = await reportFixture(fixture);
    await extractMetadata(store, scanId);
    const dataDir = join(fixture.parent, 'data');
    const report = writeReport(store, scanId, dataDir);
    const text = readFileSync(join(report.dir, 'metadata_failures.csv'), 'utf8');
    expect(text.trim()).toBe('root,rel_path,extractor,status,error');
  });

  // Task 8 item 1: summary.md and summary.json show stored metadata outcomes per extractor.
  it('summary shows stored metadata outcomes per extractor', async (context) => {
    const available = await runTool('pdfinfo', ['-v'], { timeoutMs: 5000 }).catch(() => null);
    if (available === null || available.spawnFailed) {
      context.skip('pdfinfo is not installed, so no extraction can be recorded as ok');
      return;
    }
    const fixture = makeFixture('report-files-metadata-outcomes');
    // One extraction that succeeds and one that fails, so both columns are real.
    fixture.put('report.pdf', makePdfWithInfo({ Title: 'Report', Author: 'A. Fixture' }, 2));
    fixture.put('broken.docx', 'not a docx at all');
    const { store, scanId } = await reportFixture(fixture);
    await extractMetadata(store, scanId);
    const dataDir = join(fixture.parent, 'data');
    const report = writeReport(store, scanId, dataDir);

    const markdown = readFileSync(join(report.dir, 'summary.md'), 'utf8');
    expect(markdown).toMatch(/## Metadata outcomes/);
    expect(markdown).toMatch(/\| pdfinfo \|/);
    expect(markdown).toMatch(/\| office \|/);

    // What is stored, not what ran: one ok and one failed, counted separately.
    const summary = reportSummary(store, scanId);
    expect(summary.metadata.stored).toEqual({ ok: 1, failed: 1, timeout: 0, unavailable: 0 });
    expect(summary.metadata.byExtractor.pdfinfo).toEqual({
      ok: 1,
      failed: 0,
      timeout: 0,
      unavailable: 0,
    });
    expect(summary.metadata.byExtractor.office).toEqual({
      ok: 0,
      failed: 1,
      timeout: 0,
      unavailable: 0,
    });

    // The same figures are in summary.json, so a diff sees them.
    const json = JSON.parse(readFileSync(join(report.dir, 'summary.json'), 'utf8')) as {
      scan: { errors: number };
      metadata: { stored: { ok: number; failed: number } };
    };
    expect(json.metadata.stored.ok).toBe(1);
    expect(json.metadata.stored.failed).toBe(1);
    // The two figures stay separate: a scan error is not a metadata failure.
    expect(json.scan.errors).toBe(0);
  });

  it('escapes names containing commas, quotes, newlines and non-ASCII', async () => {
    const fixture = makeFixture('report-files-escaping');
    const awkward = 'odd, "quoted"\nnewline é中文';
    fixture.put(`${awkward}/01 one.mp3`, 'first track bytes\n');
    fixture.put(`${awkward}/02 two.mp3`, 'second track bytes\n');
    fixture.put(`${awkward}/03 three.mp3`, 'third track bytes\n');
    fixture.put('a, "one".txt', DUP_PAYLOAD);
    fixture.put('b, "two".txt', DUP_PAYLOAD);

    const { report } = await reportFixture(fixture);

    const bundleRows = parseCsv(readFileSync(join(report.dir, 'bundles.csv'), 'utf8'));
    const awkwardRow = bundleRows.find((row) => row[2]?.includes('odd'));
    expect(awkwardRow?.[2]).toBe(awkward);

    const duplicateRows = parseCsv(readFileSync(join(report.dir, 'duplicates.csv'), 'utf8'));
    expect(duplicateRows.slice(1).map((row) => row[5]).sort()).toEqual(['a, "one".txt', 'b, "two".txt']);

    const duplicatesRaw = readFileSync(join(report.dir, 'duplicates.csv'), 'utf8');
    expect(duplicatesRaw).toContain('"a, ""one"".txt"');
    const bundlesRaw = readFileSync(join(report.dir, 'bundles.csv'), 'utf8');
    expect(bundlesRaw).toContain('中文');
    expect(bundlesRaw).toContain(`"${awkward.replaceAll('"', '""')}"`);

    const markdown = readFileSync(join(report.dir, 'summary.md'), 'utf8');
    expect(markdown).toContain('newline é');
    expect(markdown.split('\n').every((line) => line.split('|').length <= 7)).toBe(true);
  });

  it('writes the report under the data directory and nothing inside the root', async () => {
    const fixture = makeFixture('report-files-readonly');
    const before = snapshot(fixture.root);
    const dataDir = join(fixture.parent, 'data');
    const { report } = await reportFixture(fixture);

    expect(report.dir.startsWith(join(dataDir, 'reports'))).toBe(true);
    expect(existsSync(report.dir)).toBe(true);
    expect(snapshot(fixture.root)).toEqual(before);
    expect(readdirSync(fixture.root).some((name) => name.endsWith('.csv') || name.endsWith('.json'))).toBe(false);
  });

  it('reports the latest finished scan when no scan is named', async () => {
    const dataDir = join(makeFixture('report-files-latest').parent, 'data');
    const store = openStore(dataDir);
    cleanups.push(() => store.close());
    const first = store.startScan('2026-01-01T00:00:00.000Z');
    store.finishScan(first, 'done', '2026-01-01T00:00:05.000Z', {
      filesSeen: 1,
      dirsSeen: 0,
      bytesSeen: 2,
      errors: 0,
      symlinksSeen: 0,
      bundlesSeen: 0,
      virtualenvsSkipped: 0,
    });
    store.startScan('2026-01-02T00:00:00.000Z');

    expect(latestFinishedScan(store)).toBe(first);
    const report = writeReport(store, first, dataDir);
    expect(report.dir).toMatch(new RegExp(`/reports/${first}-\\d{8}-\\d{4}$`));
    expect(report.summary.scan.status).toBe('done');
  });

  it('refuses to report a scan that does not exist', async () => {
    const fixture = makeFixture('report-files-missing-scan');
    const dataDir = join(fixture.parent, 'data');
    const store = openStore(dataDir);
    cleanups.push(() => store.close());
    expect(() => writeReport(store, 9999, dataDir)).toThrow(/scan 9999/i);
  });
});
