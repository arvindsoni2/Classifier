import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';import type { Decision, DecisionProvider, DecisionRequest, ProviderManifest, Result } from '../../src/domain/contracts.js';
import { loadDataset, loadLabels } from '../../src/eval/dataset.js';
import { runEvaluation, appendNodeCalibration } from '../../src/eval/runner.js';
import { scoreRun } from '../../src/eval/metrics.js';
import { exportRun } from '../../src/eval/report.js';
import { RulesProvider } from '../../src/adapters/providers/rules.js';
import { LayaProvider } from '../../src/adapters/providers/laya.js';

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'eval');

const outDirs: string[] = [];
afterAll(() => {
  for (const dir of outDirs) rmSync(dir, { recursive: true, force: true });
});

/** Records every request handed to the wrapped provider (never labels). */
class RecordingProvider implements DecisionProvider {
  readonly providerId = 'rules' as const;
  readonly captured: DecisionRequest[] = [];
  readonly provider: DecisionProvider;

  constructor(provider: DecisionProvider) {
    this.provider = provider;
  }

  health(): Promise<Result<ProviderManifest>> {
    return this.provider.health();
  }

  async decide(request: DecisionRequest): Promise<Result<Decision>> {
    this.captured.push(request);
    return this.provider.decide(request);
  }

  close(): Promise<void> {
    return this.provider.close();
  }
}

describe('loadDataset + runEvaluation on the synthetic fixture', () => {
  it('loads the frozen fixture with family-aware splits', () => {
    const dataset = loadDataset(FIXTURE);
    expect(dataset.ok).toBe(true);
    if (!dataset.ok) return;
    expect(dataset.value.items).toHaveLength(8);
    const splitOf = new Map(dataset.value.items.map((item) => [item.itemId, item.split]));
    expect(splitOf.get('item-invoice-01')).toBe(splitOf.get('item-invoice-02'));
    expect(splitOf.get('item-photo-01')).toBe(splitOf.get('item-photo-02'));
    expect(dataset.value.manifest.splitSeed).toBe(20261006);
    expect(dataset.value.datasetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(dataset.value.datasetHash).toBe(dataset.value.manifest.datasetHash);
    expect(dataset.value.taxonomyHash).toBe(dataset.value.manifest.taxonomyHash);
  });

  it('rejects a tampered manifest hash and duplicate item IDs as Result errors', () => {
    const tampered = mkdtempSync(join(tmpdir(), 'eval-tamper-'));
    outDirs.push(tampered);
    cpSync(FIXTURE, tampered, { recursive: true });
    writeFileSync(
      join(tampered, 'manifest.json'),
      JSON.stringify({ ...JSON.parse(readFileSync(join(tampered, 'manifest.json'), 'utf8')), datasetHash: 'f'.repeat(64) }),
    );
    const dataset = loadDataset(tampered);
    expect(dataset.ok).toBe(false);
    if (!dataset.ok) {
      expect(dataset.code).toBe('INVALID_DECISION');
      expect(dataset.detail).toMatch(/hash|mismatch/i);
    }

    const dupes = mkdtempSync(join(tmpdir(), 'eval-dupes-'));
    outDirs.push(dupes);
    cpSync(FIXTURE, dupes, { recursive: true });
    const firstLine = readFileSync(join(dupes, 'items.jsonl'), 'utf8').split('\n')[0] ?? '';
    appendFileSync(join(dupes, 'items.jsonl'), `${firstLine}\n`);
    const duplicated = loadDataset(dupes);
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) expect(duplicated.detail).toMatch(/duplicate/i);
  });

  it('routes deterministically and defers rather than guessing on weak evidence', async () => {
    const dataset = loadDataset(FIXTURE);
    if (!dataset.ok) throw new Error(dataset.detail);

    const run = await runEvaluation(dataset.value, [new RulesProvider()], {
      split: 'all',
      evidenceTreatment: 'compact_text',
      warmRepeats: 2,
    });

    const byItem = new Map(run.predictions.map((row) => [row.itemId, row]));
    // Rules baseline: invoice keywords match, bank statement matches.
    expect(byItem.get('item-invoice-01')?.status).toBe('completed');
    expect(byItem.get('item-invoice-01')?.predictedCategoryId).toBe('cat-invoices');
    expect(byItem.get('item-invoice-02')?.predictedCategoryId).toBe('cat-invoices');
    expect(byItem.get('item-finance-01')?.predictedCategoryId).toBe('cat-finance');
    // Metadata-only and unclear files defer explicitly (FR-05, no guesses).
    expect(byItem.get('item-photo-01')?.status).toBe('deferred');
    expect(byItem.get('item-photo-02')?.status).toBe('deferred');
    expect(byItem.get('item-software-01')?.status).toBe('deferred');
    expect(byItem.get('item-unclear-01')?.status).toBe('deferred');

    // Deterministic across identical runs (excluding timing fields).
    const run2 = await runEvaluation(dataset.value, [new RulesProvider()], {
      split: 'all',
      evidenceTreatment: 'compact_text',
      warmRepeats: 2,
    });
    const stripTiming = (rows: typeof run.predictions) =>
      rows.map((row) => ({ ...row, elapsedMs: 0 }));
    expect(stripTiming(run2.predictions)).toEqual(stripTiming(run.predictions));
  });

  it('keeps a health-blocked provider in every item as a recorded failure', async () => {
    const dataset = loadDataset(FIXTURE);
    if (!dataset.ok) throw new Error(dataset.detail);
    const run = await runEvaluation(dataset.value, [new RulesProvider(), new LayaProvider({})], {
      split: 'all',
      evidenceTreatment: 'metadata',
      warmRepeats: 1,
    });

    const layaRuns = run.providerRuns.filter((row) => row.provider === 'laya');
    expect(layaRuns).toHaveLength(1);
    expect(layaRuns[0]?.status).toBe('blocked');
    const layaPredictions = run.predictions.filter((row) => row.provider === 'laya');
    expect(layaPredictions).toHaveLength(8);
    for (const row of layaPredictions) {
      expect(row.status).toBe('failed');
      expect(row.error).toContain('Laya');
    }

    // The blocked provider still appears in the scored report, not dropped.
    const labels = loadLabels(FIXTURE);
    if (!labels.ok) throw new Error(labels.detail);
    const report = scoreRun(run, labels.value);
    expect(report.providers.laya).toBeDefined();
    expect(report.providers.laya?.status).toBe('blocked');
    // A provider that never ran reports honest nulls, not zero metrics.
    expect(report.providers.laya?.classification).toBeNull();
    expect(report.providers.laya?.deferral).toBeNull();
    expect(report.providers.laya?.probability).toBeNull();
    expect(report.notes.join(' ')).toContain('laya: blocked provider');
  });

  it('never lets labels enter inference state', async () => {
    const dataset = loadDataset(FIXTURE);
    if (!dataset.ok) throw new Error(dataset.detail);
    const recorder = new RecordingProvider(new RulesProvider());
    await runEvaluation(dataset.value, [recorder], {
      split: 'all',
      evidenceTreatment: 'compact_text',
      warmRepeats: 1,
    });
    const serialized = JSON.stringify(recorder.captured);
    expect(serialized).not.toContain('sufficientEvidence');
    expect(serialized).not.toContain('primaryCategoryId');
    expect(recorder.captured.length).toBeGreaterThan(0);
  });

  it('gives matched treatments identical evidence hashes across providers', async () => {
    const dataset = loadDataset(FIXTURE);
    if (!dataset.ok) throw new Error(dataset.detail);
    const one = new RecordingProvider(new RulesProvider());
    const two = new RecordingProvider(new RulesProvider());
    await runEvaluation(dataset.value, [one, two], {
      split: 'test',
      evidenceTreatment: 'compact_text',
      warmRepeats: 1,
    });
    expect(one.captured.length).toBeGreaterThan(0);
    expect(one.captured).toEqual(two.captured);
  });

  it('strips compact text under the metadata treatment', async () => {
    const dataset = loadDataset(FIXTURE);
    if (!dataset.ok) throw new Error(dataset.detail);
    const recorder = new RecordingProvider(new RulesProvider());
    await runEvaluation(dataset.value, [recorder], {
      split: 'all',
      evidenceTreatment: 'metadata',
      warmRepeats: 1,
    });
    for (const request of recorder.captured) {
      expect(request.evidence.state.compactText).toBeUndefined();
      expect(request.evidence.profile).toBe('metadata');
    }
  });
});

describe('exports and scoring', () => {
  it('exports the frozen JSON contracts without private evidence', async () => {
    const dataset = loadDataset(FIXTURE);
    const labels = loadLabels(FIXTURE);
    if (!dataset.ok) throw new Error(dataset.detail);
    if (!labels.ok) throw new Error(labels.detail);

    const run = await runEvaluation(dataset.value, [new RulesProvider()], {
      split: 'all',
      evidenceTreatment: 'compact_text',
      warmRepeats: 1,
    });
    const calibrated = await appendNodeCalibration(run, dataset.value, [new RulesProvider()], labels.value, {
      evidenceTreatment: 'compact_text',
    });
    expect(calibrated.nodePredictions.length).toBeGreaterThan(0);

    const outDir = mkdtempSync(join(tmpdir(), 'eval-export-'));
    outDirs.push(outDir);
    const exported = await exportRun(calibrated, dataset.value, labels.value, { outDir });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    for (const file of ['manifest.json', 'items.jsonl', 'labels.jsonl', 'predictions.jsonl', 'node_predictions.jsonl', 'run.json']) {
      expect(existsSync(join(outDir, file))).toBe(true);
    }
    // Private evidence never leaves by default.
    expect(existsSync(join(outDir, 'private-evidence.jsonl'))).toBe(false);
    const items = readFileSync(join(outDir, 'items.jsonl'), 'utf8');
    expect(items).not.toContain('compactText');
    expect(items).not.toContain('Invoice for infrastructure');
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) as {
      synthetic: boolean;
      provenance: string;
      generatedFrom: string;
    };
    // F12: boolean and string are SEPARATE and consistent. The fixture is
    // synthetic by construction; the provenance string describes it.
    expect(manifest.synthetic).toBe(true);
    expect(manifest.provenance).toBe('synthetic-fixture');
    expect(manifest.generatedFrom).toBe('synthetic-fixture');

    // The opt-in path writes a clearly named private file — and only then.
    const optInDir = mkdtempSync(join(tmpdir(), 'eval-export-private-'));
    outDirs.push(optInDir);
    const privateExport = await exportRun(calibrated, dataset.value, labels.value, {
      outDir: optInDir,
      includePrivateEvidence: true,
    });
    expect(privateExport.ok).toBe(true);
    const privateEvidence = readFileSync(join(optInDir, 'private-evidence.jsonl'), 'utf8');
    expect(privateEvidence).toContain('compactText');
    expect(privateEvidence).toContain('Invoice for infrastructure');

    const report = scoreRun(calibrated, labels.value);
    expect(report.providers.rules?.classification?.total).toBe(8);
    expect(report.synthetic).toBe(true);
  });
});
