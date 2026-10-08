/**
 * Evaluation export contracts (docs/05 §3): manifest.json, items.jsonl,
 * labels.jsonl, predictions.jsonl, node_predictions.jsonl and report.json.
 * Exports omit private evidence (raw document text) by default; only
 * item metadata and model outputs travel, never the user's content.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import type { EvalDataset, EvalLabels } from './dataset.js';
import type { EvalRun, PredictionRow } from './runner.js';
import type { EvalReport } from './metrics.js';

export interface ExportOptions {
  outDir: string;
  /** Include raw evidence state (compact text) in exports. Default: false. */
  includePrivateEvidence?: boolean;
  consentId?: string | null;
  note?: string;
}

function jsonl(rows: readonly unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

/** Frozen manifest: the run's hashes plus the machine context and treatments. */
export function buildEvalManifest(
  run: EvalRun,
  labels: EvalLabels | null,
  options: { consentId?: string | null; note?: string; includePrivateEvidence?: boolean } = {},
): Record<string, unknown> {
  const cpuList = cpus();
  return {
    schemaVersion: '1.0.0',
    synthetic: true,
    generatedFrom: 'synthetic-fixture-or-frozen-dataset',
    datasetHash: run.datasetHash,
    taxonomyHash: run.taxonomyHash,
    policyHash: '(policy revision is recorded by the application service; synthetic fixture uses policy-v1)',
    splitSeed: run.splitSeed,
    split: run.split,
    evidenceTreatment: run.evidenceTreatment,
    providerRuns: run.providerRuns.map((providerRun) => ({
      provider: providerRun.provider,
      status: providerRun.status,
      modelRevision: providerRun.modelRevision,
      runtimeRevision: providerRun.runtimeRevision,
      endpoint: providerRun.manifest?.endpoint ?? null,
      blockedDetail: providerRun.blockedDetail,
      warmedSamples: providerRun.warmedSamples.length,
      warmRepeats: providerRun.warmRepeats,
    })),
    labelsIncluded: labels !== null,
    privateEvidenceIncluded: options.includePrivateEvidence ?? false,
    consentId: options.consentId ?? null,
    machine: {
      platform: platform(),
      kernel: release(),
      cpus: cpuList.length,
      totalMemoryBytes: totalmem(),
      node: process.version,
      synthetic: true,
    },
    notes: options.note
      ? [options.note]
      : [
          'Synthetic fixture report: not laptop measurements, not user data.',
          'Longer-context treatments and real-model results are recorded separately when available.',
        ],
  };
}

interface SanitizedItemRow {
  itemId: string;
  familyId: string;
  externalId: string;
  basename: unknown;
  detectedFormat: unknown;
  sizeBytes: unknown;
  split: string;
  privateEvidenceIncluded: false;
}

export async function exportRun(
  run: EvalRun,
  dataset: EvalDataset | null,
  labels: EvalLabels | null,
  options: ExportOptions,
): Promise<{ ok: true; value: string[] } | { ok: false; code: 'OUT_OF_SCOPE' | 'UNSUPPORTED'; detail: string }> {
  const outDir = options.outDir;
  try {
    mkdirSync(outDir, { recursive: true });
  } catch (error) {
    return { ok: false, code: 'OUT_OF_SCOPE', detail: `cannot create export directory: ${(error as Error).message}` };
  }

  const files: string[] = [];

  const manifest = buildEvalManifest(run, labels, options);
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  files.push('manifest.json');

  // items.jsonl carries metadata only: basenames, formats, sizes, splits.
  // Raw document text never leaves unless explicitly selected.
  const itemRows: SanitizedItemRow[] =
    dataset?.items.map((item) => ({
      itemId: item.itemId,
      familyId: item.familyId,
      externalId: item.externalId,
      basename: item.evidence.state.basename ?? null,
      detectedFormat: item.evidence.state.detectedFormat ?? null,
      sizeBytes: item.evidence.state.sizeBytes ?? null,
      split: item.split,
      privateEvidenceIncluded: false as const,
    })) ?? [];
  writeFileSync(join(outDir, 'items.jsonl'), jsonl(itemRows));
  files.push('items.jsonl');

  if (labels !== null) {
    writeFileSync(join(outDir, 'labels.jsonl'), jsonl(Object.values(labels.labels)));
    files.push('labels.jsonl');
  }

  const predictionRows: PredictionRow[] = run.predictions;
  writeFileSync(join(outDir, 'predictions.jsonl'), jsonl(predictionRows));
  files.push('predictions.jsonl');

  writeFileSync(join(outDir, 'node_predictions.jsonl'), jsonl(run.nodePredictions));
  files.push('node_predictions.jsonl');

  writeFileSync(join(outDir, 'run.json'), `${JSON.stringify({ ...run, synthetic: true }, null, 2)}\n`);
  files.push('run.json');

  return { ok: true, value: files };
}

/** Writes the final scored report alongside the run exports. */
export function writeReport(report: EvalReport, outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'report.json'),
    `${JSON.stringify({ ...report, note: 'Synthetic fixture report; real runs record actual machine and provider measurements.' }, null, 2)}\n`,
  );
}
