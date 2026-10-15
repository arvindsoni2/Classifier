/**
 * Task 7 item 3: the `scans` row describes the whole pipeline.
 *
 * The row used to be closed by the scanner, before hashing, bundle detection and
 * metadata extraction had run. So `Duration` in the report was the walk alone, a
 * crash during hashing left a scan marked `done`, and "0.7s" next to 15,418
 * hashes claimed something untrue.
 *
 * A scan is one unit of work now: walk → hash → bundles → metadata. The row stays
 * `running` until the last stage returns, records one elapsed time for all of it,
 * and an exception anywhere leaves it `failed` naming the stage that threw.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/catalogue/config.js';
import { computeHashes } from '../../src/catalogue/dedupe.js';
import { writeReport } from '../../src/catalogue/report.js';
import { scan } from '../../src/catalogue/scanner.js';
import { openStore, type CatalogueStore } from '../../src/catalogue/store.js';
import { ext4Probe, makeTree, type Fixture } from './fixtures.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface Harness {
  fixture: Fixture;
  store: CatalogueStore;
  configPath: string;
}

function harness(label: string, entries: string[]): Harness {
  const fixture = makeTree(label, entries);
  cleanups.push(fixture.cleanup);
  const store = openStore(join(fixture.parent, 'data'));
  cleanups.push(() => store.close());
  const configPath = join(fixture.parent, 'catalogue.json');
  writeFileSync(
    configPath,
    JSON.stringify({ roots: [fixture.root], dataDir: join(fixture.parent, 'data') }),
    'utf8',
  );
  return { fixture, store, configPath };
}

interface ScanRow {
  status: string;
  started_at: string;
  finished_at: string | null;
  failure_stage: string | null;
}

function scanRow(store: CatalogueStore, scanId: number): ScanRow {
  return store.db
    .prepare('SELECT status, started_at, finished_at, failure_stage FROM scans WHERE id = ?')
    .get(scanId) as ScanRow;
}

function filesHashedOf(store: CatalogueStore, scanId: number): number {
  return (
    store.db.prepare('SELECT files_hashed FROM scans WHERE id = ?').get(scanId) as {
      files_hashed: number;
    }
  ).files_hashed;
}

/** The rendered `summary.md` for a scan, read back from disk. */
function summaryMd(store: CatalogueStore, scanId: number, dataDir: string): string {
  const report = writeReport(store, scanId, dataDir);
  return readFileSync(join(report.dir, 'summary.md'), 'utf8');
}

describe('scan status covers the whole pipeline (Task 7 item 3)', () => {
  it('stays running until the last stage finishes, then becomes done', async () => {
    const { store, configPath } = harness('scan-stages', ['a/one.txt', 'a/two.txt']);
    const seenDuringStages: string[] = [];

    const result = await scan(loadConfig(configPath), store, {
      volumeProbe: ext4Probe(),
      stages: [
        {
          name: 'hash',
          run: async (scanId) => {
            // The row is still open while this stage runs: nothing may report the
            // scan as finished before its figures are final.
            seenDuringStages.push(scanRow(store, scanId).status);
          },
        },
        {
          name: 'bundles',
          run: async (scanId) => {
            seenDuringStages.push(scanRow(store, scanId).status);
          },
        },
        {
          name: 'metadata',
          run: async (scanId) => {
            seenDuringStages.push(scanRow(store, scanId).status);
          },
        },
      ],
    });

    expect(seenDuringStages).toEqual(['running', 'running', 'running']);
    const row = scanRow(store, result.scanId);
    expect(row.status).toBe('done');
    expect(row.failure_stage).toBeNull();
    expect(row.finished_at).not.toBeNull();
  });

  it('records one elapsed time covering the stages, not the walk alone', async () => {
    const { store, configPath } = harness('scan-elapsed', ['a/one.txt']);
    let stageFinishedAt: number | null = null;

    const result = await scan(loadConfig(configPath), store, {
      volumeProbe: ext4Probe(),
      stages: [
        {
          name: 'hash',
          run: async () => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            stageFinishedAt = Date.now();
          },
        },
      ],
    });

    const row = scanRow(store, result.scanId);
    // `finished_at` is written after the stage returned, so the row's own elapsed
    // time includes work the walk could not have accounted for.
    expect(stageFinishedAt).not.toBeNull();
    expect(new Date(row.finished_at ?? 0).getTime()).toBeGreaterThanOrEqual(stageFinishedAt ?? 0);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(25);
  });

  it('an exception during hashing leaves the row failed and names the stage', async () => {
    const { store, configPath } = harness('scan-hash-throw', ['a/one.txt']);

    await expect(
      scan(loadConfig(configPath), store, {
        volumeProbe: ext4Probe(),
        stages: [
          {
            name: 'hash',
            run: async () => {
              throw new Error('ENOSPC: no space left on device');
            },
          },
        ],
      }),
    ).rejects.toThrow(/ENOSPC/);

    const row = scanRow(store, 1);
    expect(row.status).toBe('failed');
    expect(row.failure_stage).toBe('hash');
    expect(row.finished_at).not.toBeNull();
  });

  it('names the walk when the walk itself throws, not a stage', async () => {
    const { store, configPath } = harness('scan-walk-throw', ['a/one.txt']);
    const broken: CatalogueStore = {
      ...store,
      upsertDir: () => {
        throw new Error('SQLITE_READONLY: attempt to write a readonly database');
      },
    };

    await expect(scan(loadConfig(configPath), broken, { volumeProbe: ext4Probe() })).rejects.toThrow(
      /SQLITE_READONLY/,
    );
    expect(scanRow(store, 1).failure_stage).toBe('walk');
  });

  it('reports each stage result so the caller can print its numbers', async () => {
    const { store, configPath } = harness('scan-stage-results', ['a/one.txt']);

    const result = await scan(loadConfig(configPath), store, {
      volumeProbe: ext4Probe(),
      stages: [
        { name: 'hash', run: async () => ({ filesHashed: 7 }) },
        { name: 'metadata', run: async () => ({ ok: 3 }) },
      ],
    });

    expect(result.stageResults.get('hash')).toEqual({ filesHashed: 7 });
    expect(result.stageResults.get('metadata')).toEqual({ ok: 3 });
  });

  it('a scan with no stages still finishes, and is not marked failed', async () => {
    const { store, configPath } = harness('scan-no-stages', ['a/one.txt']);
    const result = await scan(loadConfig(configPath), store, { volumeProbe: ext4Probe() });
    expect(scanRow(store, result.scanId).status).toBe('done');
    expect(scanRow(store, result.scanId).failure_stage).toBeNull();
  });

  // The hash stage is the only writer of `files_hashed`. The walk never counts
  // hashes, so a scan that finishes after its stages must not overwrite the
  // hash stage's figure with the walk's zero — which is what it did once the
  // stages moved inside the scan row (Task 7 follow-up).
  it('files_hashed is the hash stage\'s count, and the scan closing does not erase it', async () => {
    const { fixture, store, configPath } = harness('files-hashed', []);
    const dataDir = join(fixture.parent, 'data');
    // Two files of equal size are hashing candidates; the third is not, so the
    // hash stage reads two files and the walk reads none.
    fixture.put('a.txt', 'aaaa\n');
    fixture.put('b.txt', 'bbbb\n');
    fixture.put('c.txt', 'a unique size\n');
    const config = loadConfig(configPath);
    const hashStage = { name: 'hash', run: (scanId: number) => computeHashes(store, scanId) };

    const first = await scan(config, store, { volumeProbe: ext4Probe(), stages: [hashStage] });
    expect(filesHashedOf(store, first.scanId)).toBe(2);
    expect(summaryMd(store, first.scanId, dataDir)).toContain('Files hashed: 2.');

    // A rescan finds nothing that needs hashing: 0, not the previous scan's 2.
    const second = await scan(config, store, { volumeProbe: ext4Probe(), stages: [hashStage] });
    expect(filesHashedOf(store, second.scanId)).toBe(0);
    expect(summaryMd(store, second.scanId, dataDir)).toContain('Files hashed: 0.');
  });
});