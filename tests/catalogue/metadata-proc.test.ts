/**
 * Phase 1 Task 4: the bounds around metadata extraction (plan docs/11-Phase-1-Plan.md Task 4).
 *
 * Two things here are not about what any extractor reads, but about the machinery
 * that runs them: `proc.ts`'s three bounds (a deadline, an output cap, and an
 * argument array with no shell), and the runner's cap of two extractions at a
 * time. Both exist so one pathological file cannot stall a scan of a large root.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTool } from '../../src/catalogue/metadata/proc.js';
import { scan } from '../../src/catalogue/scanner.js';
import { loadConfig } from '../../src/catalogue/config.js';
import {
  extractMetadata,
  type Extractor,
  type MetadataRunSummary,
} from '../../src/catalogue/metadata/index.js';
import { openStore, type CatalogueStore } from '../../src/catalogue/store.js';
import { makeDocxWithCoreProperties } from '../fixtures/documents.js';
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

async function scanFixture(
  fixture: Fixture,
  options: { extractors?: Extractor[] } = {},
): Promise<{ store: CatalogueStore; summary: MetadataRunSummary }> {
  const store = openStoreFor(fixture);
  const configPath = join(fixture.parent, 'catalogue.json');
  writeFileSync(
    configPath,
    JSON.stringify({ roots: [fixture.root], dataDir: join(fixture.parent, 'data') }),
    'utf8',
  );
  const result = await scan(loadConfig(configPath), store, {});
  const summary = await extractMetadata(store, result.scanId, options);
  return { store, summary };
}

/** An extractor that reports a fixed result and counts what it was asked to do. */
function fakeExtractor(overrides: Partial<Extractor> & { name: string }): Extractor & { calls: number } {
  const extractor = {
    version: 'fake@1.0.0',
    appliesTo: () => true,
    available: async () => true,
    extract: async () => ({ marker: 'fake' }),
    ...overrides,
    calls: 0,
  } as Extractor & { calls: number };
  const baseExtract = extractor.extract;
  extractor.extract = async (absPath, signal) => {
    extractor.calls += 1;
    return baseExtract(absPath, signal);
  };
  return extractor;
}

describe('metadata extraction bounds (Phase 1 Task 4)', () => {
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

  it('extraction runs two at a time', async () => {
    const fixture = makeFixture('metadata-concurrency');
    for (let index = 1; index <= 6; index += 1) {
      fixture.put(
        `doc-${index}.docx`,
        makeDocxWithCoreProperties(
          `<?xml version="1.0"?><cp:coreProperties><dc:title>Doc ${index}</dc:title></cp:coreProperties>`,
        ),
      );
    }
    let active = 0;
    let peak = 0;
    const slow = fakeExtractor({
      name: 'slow',
      appliesTo: (_kind, ext) => ext === 'docx',
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
});