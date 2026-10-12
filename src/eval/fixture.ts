/**
 * `pnpm eval:fixture` driver (plan Task 5): runs the deterministic synthetic
 * fixture dataset through the rules provider (and the honestly blocked Laya
 * provider), scores it, and exports the frozen contract files. Results are
 * synthetic by construction — never laptop measurements, never user data.
 */
import { loadDataset, loadLabels, type EvalDataset } from './dataset.js';
import { RulesProvider } from '../adapters/providers/rules.js';
import { LayaProvider } from '../adapters/providers/laya.js';
import { runEvaluation, appendNodeCalibration } from './runner.js';
import { scoreRun } from './metrics.js';
import { exportRun, writeReport } from './report.js';
import type { Result } from '../domain/contracts.js';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
  return result.value;
}

async function main(fixtureDir: string, outDir: string): Promise<void> {
  const dataset: EvalDataset = unwrap(loadDataset(fixtureDir));
  const labels = unwrap(loadLabels(fixtureDir));

  const providers = [new RulesProvider(), new LayaProvider({})];
  const run = await runEvaluation(dataset, providers, {
    split: 'all',
    evidenceTreatment: 'compact_text',
    warmRepeats: 3,
  });
  // No explicit split: calibration cohorts derive from the run (F12).
  const calibrated = await appendNodeCalibration(run, dataset, providers, labels, {
    evidenceTreatment: 'compact_text',
  });
  const report = scoreRun(calibrated, labels);

  const exported = await exportRun(calibrated, dataset, labels, {
    outDir,
    note: 'Deterministic synthetic fixture run: rules provider plus honestly blocked Laya; not measurements.',
  });
  if (!exported.ok) throw new Error(`${exported.code}: ${exported.detail}`);
  writeReport(report, outDir);

  const summary = Object.fromEntries(
    Object.entries(report.providers).map(([name, providerReport]) => [
      name,
      {
        status: providerReport.status,
        classification: providerReport.classification && {
          completion: providerReport.classification.completion,
          conditionalAccuracy: providerReport.classification.conditionalAccuracy,
          completionAdjustedAccuracy: providerReport.classification.completionAdjustedAccuracy,
          primaryTop1: providerReport.classification.primaryTop1,
          acceptableTop1: providerReport.classification.acceptableTop1,
          macroF1: providerReport.classification.macroF1,
          accuracyWilson95: providerReport.classification.accuracyWilson,
        },
        deferral: providerReport.deferral,
        probability: providerReport.probability,
        runtime: {
          warmedP50Ms: providerReport.runtime.warmedP50Ms,
          warmedP95Ms: providerReport.runtime.warmedP95Ms,
          warmRepeats: providerReport.runtime.warmRepeats,
        },
      },
    ]),
  );

  console.log(
    JSON.stringify(
      {
        // The fixture is synthetic BY CONSTRUCTION (spec review F12): the
        // summary states it truthfully, matching the manifest.
        synthetic: true,
        provenance: 'synthetic-fixture',
        fixtureDir,
        outDir,
        files: exported.value,
        providers: summary,
      },
      null,
      2,
    ),
  );
}

export async function runFixtureCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const fixtureDir = argv[0] ?? 'tests/fixtures/eval';
  const outDir = argv[1] ?? 'build/eval-fixture';
  await main(fixtureDir, outDir);
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith('fixture.js');
if (isMain) {
  await runFixtureCli();
}
