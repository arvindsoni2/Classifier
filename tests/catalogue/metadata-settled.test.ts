/**
 * Phase 1 Task 8 item 2, as sharpened by the Task 8 review: deterministic
 * metadata failures settle *at a version*, not forever.
 *
 * `failed` joins `ok` as settled only when the stored row's extractor version is
 * the extractor's current one; an older row is re-extracted (a version bump means
 * behaviour changed). `timeout` and `unavailable` are still retried every scan.
 * A changed file drops its metadata rows during the scan, so it is retried then.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractMetadata, metadataRows, type Extractor } from '../../src/catalogue/metadata/index.js';
import { loadConfig } from '../../src/catalogue/config.js';
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

function failingExtractor(name: string, version = 'fake@1.0.0'): Extractor & { calls: number } {
  const extractor = {
    name,
    version,
    appliesTo: () => true,
    available: async () => true,
    extract: async () => {
      throw new Error('extraction failed');
    },
    calls: 0,
  } as Extractor & { calls: number };
  const base = extractor.extract;
  extractor.extract = async (absPath, signal) => {
    extractor.calls += 1;
    return base(absPath, signal);
  };
  return extractor;
}

function hungExtractor(name: string): Extractor & { calls: number } {
  const extractor = {
    name,
    version: 'fake@1.0.0',
    appliesTo: () => true,
    available: async () => true,
    extract: () => new Promise<Record<string, unknown>>(() => {}),
    calls: 0,
  } as Extractor & { calls: number };
  const base = extractor.extract;
  extractor.extract = async (absPath, signal) => {
    extractor.calls += 1;
    return base(absPath, signal);
  };
  return extractor;
}

function unavailableExtractor(name: string): Extractor & { calls: number; availableCalls: number } {
  const extractor = {
    name,
    version: 'fake@1.0.0',
    appliesTo: () => true,
    available: async () => false,
    extract: async () => ({}),
    calls: 0,
    availableCalls: 0,
  } as Extractor & { calls: number; availableCalls: number };
  const baseAvailable = extractor.available;
  extractor.available = async () => {
    extractor.availableCalls += 1;
    return baseAvailable();
  };
  return extractor;
}

describe('settled metadata failures (Task 8 item 2)', () => {
  it('a failed row from an older extractor version is re-extracted; the current version settles', async () => {
    const fixture = makeFixture('settled-version');
    fixture.put('broken.epub', Buffer.from('not a zip at all'));
    const old = failingExtractor('failing', 'fake@1.0.0');
    const store = openStoreFor(fixture);
    const scanId = await scanOnly(fixture, store);
    await extractMetadata(store, scanId, { extractors: [old] });
    expect(old.calls).toBe(1);
    expect(metadataRows(store)[0]?.extractorVersion).toBe('fake@1.0.0');

    // The extractor bumped: the old failed row no longer settles, so it is
    // retried once and the row carries the new version.
    const next = failingExtractor('failing', 'fake@1.1.0');
    const secondScanId = await scanOnly(fixture, store);
    const second = await extractMetadata(store, secondScanId, { extractors: [next] });
    expect(next.calls).toBe(1);
    expect(second.extracted).toBe(1);
    expect(second.unchanged).toBe(0);
    expect(metadataRows(store)[0]?.extractorVersion).toBe('fake@1.1.0');

    // The same version on the next rescan is settled again.
    const thirdScanId = await scanOnly(fixture, store);
    const third = await extractMetadata(store, thirdScanId, { extractors: [next] });
    expect(next.calls).toBe(1);
    expect(third.extracted).toBe(0);
    expect(third.unchanged).toBe(1);
  });

  it('a failed extraction is settled and not retried on an unchanged rescan', async () => {
    const fixture = makeFixture('settled-failed');
    fixture.put('broken.epub', Buffer.from('not a zip at all'));
    const failing = failingExtractor('failing');
    const store = openStoreFor(fixture);
    const scanId = await scanOnly(fixture, store);
    const first = await extractMetadata(store, scanId, { extractors: [failing] });
    expect(failing.calls).toBe(1);
    expect(first.failed).toBe(1);

    // Nothing changed on disk: the failed row is settled, so it is not retried.
    const secondScanId = await scanOnly(fixture, store);
    const second = await extractMetadata(store, secondScanId, { extractors: [failing] });
    expect(failing.calls).toBe(1);
    expect(second.unchanged).toBe(1);
    expect(second.extracted).toBe(0);
    expect(metadataRows(store)).toHaveLength(1);
    expect(metadataRows(store)[0]?.status).toBe('failed');
    expect(metadataRows(store)[0]?.extractedScan).toBe(scanId);
  });

  it('a changed file drops its failed metadata and is retried', async () => {
    const fixture = makeFixture('settled-changed');
    fixture.put('broken.epub', Buffer.from('not a zip at all'));
    const failing = failingExtractor('failing');
    const store = openStoreFor(fixture);
    const scanId = await scanOnly(fixture, store);
    await extractMetadata(store, scanId, { extractors: [failing] });
    expect(failing.calls).toBe(1);

    // Replacing the file drops its metadata rows, so it is extracted again.
    fixture.put('broken.epub', Buffer.from('still not a zip'));
    const secondScanId = await scanOnly(fixture, store);
    const second = await extractMetadata(store, secondScanId, { extractors: [failing] });
    expect(failing.calls).toBe(2);
    expect(second.extracted).toBe(1);
    expect(second.failed).toBe(1);
    expect(metadataRows(store)[0]?.extractedScan).toBe(secondScanId);
  });

  it('a timeout is retried on every scan', async () => {
    const fixture = makeFixture('settled-timeout');
    fixture.put('slow.pdf', Buffer.from('%PDF-1.7\n%EOF\n'));
    const hung = hungExtractor('hung');
    const store = openStoreFor(fixture);
    const scanId = await scanOnly(fixture, store);
    const first = await extractMetadata(store, scanId, { extractors: [hung], timeoutMs: 30 });
    expect(hung.calls).toBe(1);
    expect(first.timeouts).toBe(1);

    const secondScanId = await scanOnly(fixture, store);
    const second = await extractMetadata(store, secondScanId, { extractors: [hung], timeoutMs: 30 });
    expect(hung.calls).toBe(2); // timeout is not settled: retried
    expect(second.timeouts).toBe(1);
  });

  it('an unavailable extractor is retried on every scan', async () => {
    const fixture = makeFixture('settled-unavailable');
    fixture.put('doc.docx', 'not a docx');
    const absent = unavailableExtractor('absent');
    const store = openStoreFor(fixture);
    const scanId = await scanOnly(fixture, store);
    const first = await extractMetadata(store, scanId, { extractors: [absent] });
    expect(absent.availableCalls).toBe(1);
    expect(first.unavailable).toBe(1);

    const secondScanId = await scanOnly(fixture, store);
    const second = await extractMetadata(store, secondScanId, { extractors: [absent] });
    expect(absent.availableCalls).toBe(2); // unavailable is not settled: retried
    expect(second.unavailable).toBe(1);
  });

  it('an extractor whose availability changes is re-probed', async () => {
    const fixture = makeFixture('settled-availability');
    fixture.put('doc.docx', 'not a docx');
    let available = false;
    const extractor = {
      name: 'toggles',
      version: 'fake@1.0.0',
      appliesTo: () => true,
      available: async () => available,
      extract: async () => ({ title: 'Fine' }),
      calls: 0,
    } as Extractor & { calls: number };
    const base = extractor.extract;
    extractor.extract = async (absPath, signal) => {
      extractor.calls += 1;
      return base(absPath, signal);
    };
    const store = openStoreFor(fixture);
    const scanId = await scanOnly(fixture, store);
    const first = await extractMetadata(store, scanId, { extractors: [extractor] });
    expect(first.unavailable).toBe(1);
    expect(extractor.calls).toBe(0);

    // The tool appears between scans: the unavailable row is retried and now ok.
    available = true;
    const secondScanId = await scanOnly(fixture, store);
    const second = await extractMetadata(store, secondScanId, { extractors: [extractor] });
    expect(second.ok).toBe(1);
    expect(extractor.calls).toBe(1);
  });
});
