/**
 * Evaluation metrics (docs/05 §5): classification, deferral, probability
 * quality and runtime — with Wilson intervals for single proportions, a
 * family-aware paired bootstrap for provider differences, and an explicit
 * separation of completion-adjusted and conditional accuracy so failure
 * exclusion cannot hide an unusable runtime.
 */
import { SPLIT_SEED, type EvalLabels } from './dataset.js';
import type { EvalRun, NodePredictionRow, PredictionRow } from './runner.js';

export interface ConfidenceInterval {
  low: number;
  high: number;
}

/** Wilson score interval for a binomial proportion. */
export function wilsonInterval(successes: number, total: number, z = 1.96): ConfidenceInterval {
  if (total === 0) return { low: 0, high: 0 };
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = p + z2 / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return {
    low: Math.max(0, (center - spread) / denominator),
    high: Math.min(1, (center + spread) / denominator),
  };
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CorrectnessItem {
  itemId: string;
  familyId: string;
  correct: boolean;
}

/** Accuracy treating failures as failures, per family for resampling. */
export function accuracy(items: readonly CorrectnessItem[]): number {
  if (items.length === 0) return 0;
  return items.filter((item) => item.correct).length / items.length;
}

export interface PairedDifference {
  providerA: string;
  providerB: string;
  deltaCompletionAdjusted: number;
  ci95: ConfidenceInterval;
}

/**
 * Bootstrap resampling of FAMILY UNITS with replacement (docs/05 §5):
 * duplicate families are resampled as units; multiplicity is required for a
 * true bootstrap distribution.
 */
export function resampleFamilies(
  families: readonly string[],
  count: number,
  random: () => number,
): string[] {
  const picks: string[] = [];
  if (families.length === 0) return picks;
  const total = Math.max(1, count);
  for (let i = 0; i < total; i++) {
    picks.push(families[Math.floor(random() * families.length)] ?? families[0]!);
  }
  return picks;
}

/**
 * Family-aware paired bootstrap: resample duplicate families as units with
 * replacement and report the percentile interval of the accuracy difference.
 */
export function pairedBootstrapDifference(
  itemsA: readonly CorrectnessItem[],
  itemsB: readonly CorrectnessItem[],
  resamples = 1000,
  seed: number = SPLIT_SEED,
): { deltaCompletionAdjusted: number; ci95: ConfidenceInterval } {
  const families = [...new Set([...itemsA, ...itemsB].map((item) => item.familyId))].sort((a, b) =>
    a < b ? -1 : 1,
  );
  const random = mulberry32(seed);
  const deltas: number[] = [];
  for (let i = 0; i < resamples; i++) {
    const picks = resampleFamilies(families, families.length, random);
    const sampleA = itemsA.filter((item) => picks.includes(item.familyId));
    const sampleB = itemsB.filter((item) => picks.includes(item.familyId));
    deltas.push(accuracy(sampleA) - accuracy(sampleB));
  }
  deltas.sort((a, b) => a - b);
  return {
    deltaCompletionAdjusted: accuracy(itemsA) - accuracy(itemsB),
    ci95: {
      low: deltas[Math.floor(0.025 * resamples)] ?? 0,
      high: deltas[Math.floor(0.975 * resamples)] ?? 0,
    },
  };
}

export interface CategoryScore {
  categoryId: string;
  support: number;
  predictedSupport: number;
  correct: number;
}

export interface ClassificationReport {
  completed: number;
  deferred: number;
  failed: number;
  total: number;
  completion: number;
  conditionalAccuracy: number | null;
  completionAdjustedAccuracy: number;
  primaryTop1: number;
  acceptableTop1: number;
  macroF1: number;
  perCategory: CategoryScore[];
  accuracyWilson: ConfidenceInterval;
}

export interface DeferralReport {
  insufficient: number;
  deferred: number;
  unknownRecall: number | null;
  unknownPrecision: number | null;
  coverage: number;
  errorRateAmongRetained: number | null;
}

export interface ProbabilityReport {
  multiclassBrier: number;
  ece5Bin: number;
  nodeSupport: number;
}

export interface RuntimeReport {
  elapsedTotalMs: number;
  warmedP50Ms: number | null;
  warmedP95Ms: number | null;
  warmedSamples: number;
  warmRepeats: number;
}

export interface ProviderReport {
  provider: string;
  status: string;
  modelRevision: string;
  runtimeRevision: string;
  evidenceProfile: string;
  classification: ClassificationReport | null;
  deferral: DeferralReport | null;
  probability: ProbabilityReport | null;
  runtime: RuntimeReport;
}

export interface EvalReport {
  /** Fact about the dataset (F12): true only for the synthetic fixture. */
  synthetic: boolean;
  /** What the dataset actually is: 'synthetic-fixture' or a labelled set id. */
  provenance: string;
  split: string;
  evidenceTreatment: string;
  datasetHash: string;
  taxonomyHash: string;
  splitSeed: number;
  providers: Record<string, ProviderReport>;
  paired: PairedDifference[];
  notes: string[];
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * sorted.length)));
  return sorted[index] ?? null;
}

function macroF1(perCategory: CategoryScore[]): number {
  if (perCategory.length === 0) return 0;
  let sum = 0;
  for (const score of perCategory) {
    const precision = score.predictedSupport > 0 ? score.correct / score.predictedSupport : 0;
    const recall = score.support > 0 ? score.correct / score.support : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    sum += f1;
  }
  return sum / perCategory.length;
}

/** Per-node multiclass Brier (sum of squared errors over the option vector). */
export function multiclassBrier(rows: readonly NodePredictionRow[]): number | null {
  if (rows.length === 0) return null;
  let total = 0;
  for (const row of rows) {
    for (const [optionId, probability] of Object.entries(row.probabilities)) {
      const observed = optionId === row.trueOptionId ? 1 : 0;
      const safeProbability = typeof probability === 'number' && Number.isFinite(probability) ? probability : 0;
      total += (safeProbability - observed) ** 2;
    }
  }
  return total / rows.length;
}

/** Five-bin expected calibration error on the selected option's confidence. */
export function eceFiveBin(rows: readonly NodePredictionRow[]): number | null {
  if (rows.length === 0) return null;
  const bins = Array.from({ length: 5 }, () => ({ count: 0, confidenceSum: 0, correct: 0 }));
  for (const row of rows) {
    const confidence = row.probabilities[row.selectedId];
    if (confidence === undefined || !Number.isFinite(confidence)) continue;
    const index = Math.min(4, Math.max(0, Math.floor(confidence * 5)));
    bins[index]!.count += 1;
    bins[index]!.confidenceSum += confidence;
    if (row.selectedId === row.trueOptionId) bins[index]!.correct += 1;
  }
  let ece = 0;
  for (const bin of bins) {
    if (bin.count === 0) continue;
    ece += (bin.count / rows.length) * Math.abs(bin.correct / bin.count - bin.confidenceSum / bin.count);
  }
  return ece;
}

export function scoreRun(run: EvalRun, labels: EvalLabels): EvalReport {
  const byProvider = new Map<string, PredictionRow[]>();
  for (const prediction of run.predictions) {
    const list = byProvider.get(prediction.provider) ?? [];
    list.push(prediction);
    byProvider.set(prediction.provider, list);
  }

  const providers: Record<string, ProviderReport> = {};
  const correctnessByProvider = new Map<string, CorrectnessItem[]>();
  const notes: string[] = [];

  for (const [provider, predictions] of byProvider) {
    const completed = predictions.filter((row) => row.status === 'completed');
    const deferred = predictions.filter((row) => row.status === 'deferred');
    const failed = predictions.filter((row) => row.status === 'failed');
    const total = predictions.length;

    const labelled = completed.filter((row) => labels.labels[row.itemId] !== undefined);
    const correctPrimary = labelled.filter((row) => {
      const label = labels.labels[row.itemId];
      return label !== undefined && row.predictedCategoryId === label.primaryCategoryId;
    });
    const correctAcceptable = labelled.filter((row) => {
      const label = labels.labels[row.itemId];
      return label !== undefined && label.acceptableCategoryIds.includes(row.predictedCategoryId ?? '');
    });

    const categories = new Set<string>();
    for (const label of Object.values(labels.labels)) {
      if (predictions.some((row) => row.itemId === label.itemId)) categories.add(label.primaryCategoryId);
    }
    for (const row of predictions) {
      if (row.predictedCategoryId !== null) categories.add(row.predictedCategoryId);
    }
    const perCategory = new Map<string, CategoryScore>();
    for (const categoryId of categories) {
      perCategory.set(categoryId, {
        categoryId,
        support: 0,
        predictedSupport: 0,
        correct: 0,
      });
    }
    for (const label of Object.values(labels.labels)) {
      const score = perCategory.get(label.primaryCategoryId);
      if (score === undefined || !predictions.some((row) => row.itemId === label.itemId)) continue;
      score.support += 1;
      const prediction = predictions.find((row) => row.itemId === label.itemId);
      if (prediction?.status === 'completed' && prediction.predictedCategoryId === label.primaryCategoryId) {
        score.correct += 1;
      }
    }
    // Predicted support counts every prediction in that category exactly once.
    for (const row of predictions) {
      const score = row.predictedCategoryId === null ? undefined : perCategory.get(row.predictedCategoryId);
      if (score !== undefined) score.predictedSupport += 1;
    }

    const conditionalAccuracy = labelled.length > 0 ? correctPrimary.length / labelled.length : null;
    const classification: ClassificationReport | null =
      labelled.length > 0
        ? {
            completed: completed.length,
            deferred: deferred.length,
            failed: failed.length,
            total,
            completion: completed.length / total,
            conditionalAccuracy,
            completionAdjustedAccuracy: correctPrimary.length / total,
            primaryTop1: correctPrimary.length / labelled.length,
            acceptableTop1: correctAcceptable.length / labelled.length,
            macroF1: macroF1([...perCategory.values()]),
            perCategory: [...perCategory.values()],
            accuracyWilson: wilsonInterval(correctPrimary.length, total),
          }
        : null;
    if (classification === null) {
      notes.push(`${provider}: no labelled items in this split; classification metrics not computed`);
    }

    // Deferral metrics use the sufficient-evidence labels (docs/05 §5).
    const insufficient = predictions.filter(
      (row) => labels.labels[row.itemId]?.sufficientEvidence === false,
    );
    const deferral: DeferralReport = {
      insufficient: insufficient.length,
      deferred: deferred.length,
      unknownRecall:
        insufficient.length > 0
          ? insufficient.filter((row) => row.status === 'deferred').length / insufficient.length
          : null,
      unknownPrecision:
        deferred.length > 0
          ? deferred.filter((row) => labels.labels[row.itemId]?.sufficientEvidence === false).length / deferred.length
          : null,
      coverage: completed.length / total,
      errorRateAmongRetained:
        labelled.length > 0 ? 1 - (correctPrimary.length / labelled.length) : null,
    };
    if (deferral.unknownRecall === null || deferral.unknownPrecision === null) {
      notes.push(`${provider}: deferral recall/precision need labelled insufficient-evidence items; sparse results are exploratory`);
    }

    const nodeRows = run.nodePredictions.filter((row) => row.provider === provider);
    const brier = multiclassBrier(nodeRows);
    const ece = eceFiveBin(nodeRows);
    const probability: ProbabilityReport | null =
      brier !== null && ece !== null
        ? { multiclassBrier: brier, ece5Bin: ece, nodeSupport: nodeRows.length }
        : null;
    if (probability === null) {
      notes.push(`${provider}: no teacher-forced node calibration rows; probability quality not evaluated for this provider`);
    }

    const runRow = run.providerRuns.find((row) => row.provider === provider);
    const blocked = (runRow?.status ?? 'unknown') !== 'ok';
    const samples = [...(runRow?.warmedSamples ?? [])].sort((a, b) => a - b);
    const runtime: RuntimeReport = {
      elapsedTotalMs: runRow?.elapsedTotalMs ?? 0,
      warmedP50Ms: percentile(samples, 0.5),
      warmedP95Ms: percentile(samples, 0.95),
      warmedSamples: samples.length,
      warmRepeats: runRow?.warmRepeats ?? 0,
    };

    providers[provider] = {
      provider,
      status: runRow?.status ?? 'unknown',
      modelRevision: runRow?.modelRevision ?? 'unknown',
      runtimeRevision: runRow?.runtimeRevision ?? 'unknown',
      evidenceProfile: predictions[0]?.evidenceProfile ?? run.evidenceTreatment,
      classification: blocked ? null : classification,
      deferral: blocked ? null : deferral,
      probability: blocked ? null : probability,
      runtime,
    };

    if (blocked) {
      notes.push(
        `${provider}: blocked provider — health failed; every item is recorded as a failure and the provider is not dropped from the report`,
      );
    }

    correctnessByProvider.set(
      provider,
      predictions.map((row) => {
        const label = labels.labels[row.itemId];
        return {
          itemId: row.itemId,
          familyId: row.familyId,
          correct: row.status === 'completed' && label !== undefined && row.predictedCategoryId === label.primaryCategoryId,
        };
      }),
    );
  }

  const providerNames = [...correctnessByProvider.keys()].sort((a, b) => (a < b ? -1 : 1));
  const paired: PairedDifference[] = [];
  for (let i = 0; i < providerNames.length - 1; i++) {
    const a = providerNames[i]!;
    const b = providerNames[i + 1]!;
    const itemsA = correctnessByProvider.get(a) ?? [];
    const itemsB = correctnessByProvider.get(b) ?? [];
    const difference = pairedBootstrapDifference(itemsA, itemsB);
    paired.push({ ...difference, providerA: a, providerB: b });
  }

  return {
    synthetic: run.provenance === 'synthetic-fixture',
    provenance: run.provenance,
    split: run.split,
    evidenceTreatment: run.evidenceTreatment,
    datasetHash: run.datasetHash,
    taxonomyHash: run.taxonomyHash,
    splitSeed: run.splitSeed,
    providers,
    paired,
    notes,
  };
}
