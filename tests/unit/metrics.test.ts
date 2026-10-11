import { describe, expect, it } from 'vitest';
import { assignSplits } from '../../src/eval/dataset.js';
import {
  eceFiveBin,
  multiclassBrier,
  pairedBootstrapDifference,
  resampleFamilies,
  scoreRun,
  wilsonInterval,
} from '../../src/eval/metrics.js';
import type {
  EvalRun,
  NodePredictionRow,
  PredictionRow,
  ProviderRun,
} from '../../src/eval/runner.js';
import type { EvalLabels } from '../../src/eval/dataset.js';

function prediction(
  itemId: string,
  familyId: string,
  status: PredictionRow['status'],
  predictedCategoryId: string | null,
): PredictionRow {
  return {
    itemId,
    familyId,
    split: 'test',
    provider: 'rules',
    modelRevision: 'rules@1.0.0',
    runtimeRevision: 'v22.23.2',
    evidenceProfile: 'metadata',
    status,
    predictedCategoryId,
    predictedDestinationId: predictedCategoryId === null ? null : `dest-${predictedCategoryId}`,
    route:
      predictedCategoryId === null
        ? []
        : [
            {
              nodeId: 'root',
              questionId: 'q-root',
              selectedId: predictedCategoryId,
              probabilities: {},
              requestHash: 'a'.repeat(64),
            },
          ],
    error: status === 'failed' ? 'PROVIDER_FAILED: provider blocked' : null,
    elapsedMs: 1,
    tokenCounts: {},
  };
}

function nodeRow(itemId: string, probabilities: Record<string, number>): NodePredictionRow {
  return {
    itemId,
    familyId: 'family-a',
    provider: 'rules',
    nodeId: 'root',
    questionId: 'q-root',
    trueOptionId: 'cat-invoices',
    selectedId: Object.keys(probabilities).reduce((best, key) =>
      (probabilities[key] ?? 0) > (probabilities[best] ?? 0) ? key : best,
    ),
    probabilities,
  };
}

const labels: EvalLabels = {
  labels: {
    'item-1': { itemId: 'item-1', primaryCategoryId: 'cat-invoices', acceptableCategoryIds: ['cat-invoices'], sufficientEvidence: true, newFolderState: 'reuse_existing' },
    'item-2': { itemId: 'item-2', primaryCategoryId: 'cat-invoices', acceptableCategoryIds: ['cat-invoices'], sufficientEvidence: true, newFolderState: 'reuse_existing' },
    'item-3': { itemId: 'item-3', primaryCategoryId: 'cat-invoices', acceptableCategoryIds: ['cat-invoices'], sufficientEvidence: true, newFolderState: 'reuse_existing' },
    'item-4': { itemId: 'item-4', primaryCategoryId: 'cat-invoices', acceptableCategoryIds: ['cat-invoices'], sufficientEvidence: true, newFolderState: 'reuse_existing' },
  },
};

/** Four-item golden run: 3 completed correct, one provider failure. */
function goldenRun(): EvalRun {
  const providerRun: ProviderRun = {
    provider: 'rules',
    modelRevision: 'rules@1.0.0',
    runtimeRevision: 'v22.23.2',
    status: 'ok',
    manifest: {
      provider: 'rules',
      modelRevision: 'rules@1.0.0',
      runtimeRevision: 'v22.23.2',
      tokenizerRevision: 'deterministic (no tokenizer)',
      questionTokenLimit: null,
      inputTokenLimit: null,
      endpoint: null,
    },
    blockedDetail: null,
    elapsedTotalMs: 10,
    warmedSamples: [3, 4, 5],
    warmRepeats: 3,
  };
  const run: EvalRun = {
    datasetHash: 'a'.repeat(64),
    taxonomyHash: 'b'.repeat(64),
    splitSeed: 20261006,
    evidenceTreatment: 'metadata',
    split: 'all',
    provenance: 'synthetic-fixture',
    predictions: [
      prediction('item-1', 'family-a', 'completed', 'cat-invoices'),
      prediction('item-2', 'family-a', 'completed', 'cat-invoices'),
      prediction('item-3', 'family-b', 'completed', 'cat-invoices'),
      prediction('item-4', 'family-b', 'failed', null),
    ],
    nodePredictions: [
      nodeRow('item-1', { 'cat-invoices': 1, unknown: 0 }),
      nodeRow('item-2', { 'cat-invoices': 1, unknown: 0 }),
      nodeRow('item-3', { 'cat-invoices': 1, unknown: 0 }),
    ],
    providerRuns: [providerRun],
  };
  return run;
}

describe('scoreRun — four-item golden report', () => {
  it('separates completion-adjusted accuracy from conditional accuracy', () => {
    const report = scoreRun(goldenRun(), labels);
    const rules = report.providers.rules;
    expect(rules).toBeDefined();
    expect(rules?.classification?.completionAdjustedAccuracy).toBe(0.75);
    expect(rules?.classification?.conditionalAccuracy).toBe(1);
    expect(rules?.classification?.completion).toBe(0.75);
    expect(rules?.classification?.completed).toBe(3);
    expect(rules?.classification?.failed).toBe(1);
    expect(report.synthetic).toBe(true);
  });

  it('scores perfect per-node one-hot predictions with Brier zero', () => {
    const report = scoreRun(goldenRun(), labels);
    expect(report.providers.rules?.probability?.multiclassBrier).toBe(0);
    expect(report.providers.rules?.probability?.ece5Bin).toBe(0);
    expect(report.providers.rules?.probability?.nodeSupport).toBe(3);
  });

  it('records honest runtime percentiles and Wilson intervals', () => {
    const report = scoreRun(goldenRun(), labels);
    expect(report.providers.rules?.runtime?.warmedP50Ms).toBe(4);
    expect(report.providers.rules?.runtime?.warmedP95Ms).toBe(5);
    const wilson = report.providers.rules?.classification?.accuracyWilson;
    expect(wilson?.low).toBeGreaterThanOrEqual(0);
    expect(wilson?.low).toBeLessThan(0.75);
    expect(wilson?.high).toBeGreaterThanOrEqual(0.75);
  });

  it('never presents failure exclusion as the primary score', () => {
    const report = scoreRun(goldenRun(), labels);
    // Conditional accuracy is reported alongside, never instead.
    const classification = report.providers.rules?.classification;
    expect(classification?.conditionalAccuracy).not.toBe(classification?.completionAdjustedAccuracy);
  });
});

describe('assignSplits', () => {
  it('keeps duplicate families together and is deterministic under the split seed', () => {
    const items = [
      { itemId: 'item-1', familyId: 'family-a' },
      { itemId: 'item-2', familyId: 'family-a' },
      { itemId: 'item-3', familyId: 'family-b' },
      { itemId: 'item-4', familyId: 'family-b' },
    ];
    const first = assignSplits(items);
    const second = assignSplits(items);
    expect(second).toEqual(first);
    expect(first['item-1']).toBe(first['item-2']);
    expect(first['item-3']).toBe(first['item-4']);
    for (const split of Object.values(first)) {
      expect(['development', 'calibration', 'test']).toContain(split);
    }
  });

  it('spreads families across the development/calibration/test splits', () => {
    const families = Array.from({ length: 20 }, (_, i) => i);
    const items = families.map((i) => ({ itemId: `item-${i}`, familyId: `family-${i}` }));
    const splits = Object.values(assignSplits(items));
    const counts = {
      development: splits.filter((s) => s === 'development').length,
      calibration: splits.filter((s) => s === 'calibration').length,
      test: splits.filter((s) => s === 'test').length,
    };
    // 20 families, 30/20/50 target: every split must receive at least one.
    expect(counts.development).toBeGreaterThanOrEqual(1);
    expect(counts.calibration).toBeGreaterThanOrEqual(1);
    expect(counts.test).toBeGreaterThanOrEqual(1);
  });
});

describe('metric primitives', () => {
  it('wilsonInterval brackets the observed proportion', () => {
    const zero = wilsonInterval(0, 0);
    expect(zero).toEqual({ low: 0, high: 0 });
    const wilson = wilsonInterval(3, 4);
    expect(wilson.low).toBeLessThanOrEqual(0.75);
    expect(wilson.high).toBeGreaterThanOrEqual(0.75);
  });

  it('computes multiclass Brier and five-bin ECE on imperfect predictions', () => {
    const rows: NodePredictionRow[] = [
      {
        itemId: 'item-1',
        familyId: 'family-a',
        provider: 'rules',
        nodeId: 'root',
        questionId: 'q-root',
        trueOptionId: 'cat-invoices',
        selectedId: 'cat-invoices',
        probabilities: { 'cat-invoices': 0.5, unknown: 0.5 },
      },
    ];
    expect(multiclassBrier(rows)).toBeCloseTo(0.5, 9);
    expect(eceFiveBin(rows)).toBeCloseTo(0.5, 9);
  });

  it('bootstraps paired accuracy differences with duplicate families as units', () => {
    const itemsA = [
      { itemId: 'i1', familyId: 'f1', correct: true },
      { itemId: 'i2', familyId: 'f1', correct: true },
      { itemId: 'i3', familyId: 'f2', correct: true },
    ];
    const itemsB = [
      { itemId: 'i1', familyId: 'f1', correct: false },
      { itemId: 'i2', familyId: 'f1', correct: false },
      { itemId: 'i3', familyId: 'f2', correct: false },
    ];
    const result = pairedBootstrapDifference(itemsA, itemsB);
    expect(result.deltaCompletionAdjusted).toBe(1);
    expect(result.ci95.low).toBe(1);
    expect(result.ci95.high).toBe(1);

    const tied = pairedBootstrapDifference(itemsA, itemsA);
    expect(tied.deltaCompletionAdjusted).toBe(0);
  });

  it('resamples families WITH REPLACEMENT (multiplicity required for a real bootstrap)', () => {
    // A deterministic draw sequence: every draw lands on the last family, so
    // a with-replacement resample yields 200 identical families.
    const picks = resampleFamilies(['f1', 'f2'], 200, () => 0.999999);
    expect(picks).toHaveLength(200);
    expect(new Set(picks).size).toBe(1);
    expect(picks[0]).toBe('f2');

    // A uniform spread over many draws uses both families.
    let index = 0;
    const mixed = resampleFamilies(['f1', 'f2'], 200, () => {
      const value = index % 2 === 0 ? 0.1 : 0.9;
      index += 1;
      return value;
    });
    expect(mixed).toHaveLength(200);
    expect(new Set(mixed).size).toBe(2);
  });

  it('counts predicted support exactly once per category', () => {
    // item-4 completed but predicted the WRONG category.
    const wrongRun = goldenRun();
    wrongRun.predictions[3] = prediction('item-4', 'family-b', 'completed', 'cat-media');
    const report = scoreRun(wrongRun, labels);
    const perCategory = report.providers.rules?.classification?.perCategory ?? [];
    const media = perCategory.find((score) => score.categoryId === 'cat-media');
    const invoices = perCategory.find((score) => score.categoryId === 'cat-invoices');
    expect(invoices?.support).toBe(4);
    expect(invoices?.predictedSupport).toBe(3);
    expect(invoices?.correct).toBe(3);
    // The one wrong prediction must not be double-counted.
    expect(media?.predictedSupport).toBe(1);
    expect(media?.correct).toBe(0);
  });
});
