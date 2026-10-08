/**
 * Frozen evaluation runner (docs/05, plan Task 5). Serial provider order,
 * one inference at a time (PRD §6), identical semantic evidence across
 * matched treatments, warmed timing repeats with identical inputs. Labels
 * never enter inference state: runEvaluation is label-free; teacher-forced
 * node calibration is a separate, explicitly labelled function.
 */
import { createHash } from 'node:crypto';
import {
  stableStringify,
  UNKNOWN_OPTION_ID,
  type Category,
  type DecisionProvider,
  type ProviderId,
  type ProviderManifest,
} from '../domain/contracts.js';
import { buildMatchedRequest } from '../domain/taxonomy.js';
import type {
  EvalDataset,
  EvalLabel,
  EvalLabels,
  SplitName,
} from './dataset.js';

export interface RouteStep {
  nodeId: string;
  questionId: string;
  selectedId: string;
  probabilities: Record<string, number>;
}

export interface PredictionRow {
  itemId: string;
  familyId: string;
  split: SplitName;
  provider: ProviderId;
  modelRevision: string;
  runtimeRevision: string;
  evidenceProfile: 'metadata' | 'compact_text';
  status: 'completed' | 'deferred' | 'failed';
  predictedCategoryId: string | null;
  predictedDestinationId: string | null;
  route: RouteStep[];
  error: string | null;
  elapsedMs: number;
  tokenCounts: Record<string, number>;
}

export interface NodePredictionRow {
  itemId: string;
  familyId: string;
  provider: ProviderId;
  nodeId: string;
  questionId: string;
  trueOptionId: string;
  selectedId: string;
  probabilities: Record<string, number>;
}

export interface ProviderRun {
  provider: ProviderId;
  modelRevision: string;
  runtimeRevision: string;
  status: 'ok' | 'blocked';
  manifest: ProviderManifest | null;
  blockedDetail: string | null;
  elapsedTotalMs: number;
  /** Per-item warmed samples: one set of numbers per warmed repeat. */
  warmedSamples: number[];
  warmRepeats: number;
}

export interface EvalRun {
  datasetHash: string;
  taxonomyHash: string;
  splitSeed: number;
  evidenceTreatment: 'metadata' | 'compact_text';
  split: SplitName | 'all';
  synthetic: true;
  predictions: PredictionRow[];
  nodePredictions: NodePredictionRow[];
  providerRuns: ProviderRun[];
}

export interface EvalConfig {
  split: SplitName | 'all';
  evidenceTreatment: 'metadata' | 'compact_text';
  /** Number of warmed timing repeats with identical inputs (default 3). */
  warmRepeats?: number;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function childrenOf(tree: Category[], parentId: string): Category[] {
  return tree
    .filter((category) => category.parentId === parentId)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function rootOf(tree: Category[]): Category | null {
  return tree.find((category) => category.parentId === null) ?? null;
}

/**
 * Treats evidence per comparison treatment. Metadata treatment strips the
 * compact text from the state (rehashing it) so providers receive identical
 * semantic evidence; provider adapters add no fields of their own.
 */
export function treatEvidence(
  evidence: EvalDataset['items'][number]['evidence'],
  treatment: EvalConfig['evidenceTreatment'],
): EvalDataset['items'][number]['evidence'] {
  if (treatment === 'compact_text') return evidence;
  const state: Record<string, unknown> = { ...evidence.state };
  delete state.compactText;
  return {
    ...evidence,
    profile: 'metadata',
    state,
    stateHash: sha256(stableStringify(state)),
  };
}

interface RouteOutcome {
  status: PredictionRow['status'];
  predictedCategoryId: string | null;
  predictedDestinationId: string | null;
  route: RouteStep[];
  error: string | null;
  tokenCounts: Record<string, number>;
}

function mergeTokenCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number') target[key] = (target[key] ?? 0) + value;
  }
}

async function runRoute(
  evidence: EvalDataset['items'][number]['evidence'],
  taxonomy: EvalDataset['taxonomy'],
  manifests: ProviderManifest[],
  provider: DecisionProvider,
): Promise<RouteOutcome> {
  const root = rootOf(taxonomy.tree);
  if (root === null) {
    return { status: 'failed', predictedCategoryId: null, predictedDestinationId: null, route: [], error: 'taxonomy has no root', tokenCounts: {} };
  }

  const route: RouteStep[] = [];
  const tokenCounts: Record<string, number> = {};
  let node: Category | null = root;

  for (let level = 0; level < 4 && node !== null; level++) {
    const children = childrenOf(taxonomy.tree, node.id);
    if (children.length === 0) {
      // A node with no children is itself the terminal category.
      const terminal = node.kind === 'existing' ? node : null;
      if (terminal === null) {
        return { status: 'deferred', predictedCategoryId: null, predictedDestinationId: null, route, error: null, tokenCounts };
      }
      return {
        status: 'completed',
        predictedCategoryId: terminal.id,
        predictedDestinationId: terminal.destinationId,
        route,
        error: null,
        tokenCounts,
      };
    }

    const request = buildMatchedRequest(evidence, { category: node, children }, manifests);
    if (!request.ok) {
      return {
        status: 'failed',
        predictedCategoryId: null,
        predictedDestinationId: null,
        route,
        error: `request fit failed: ${request.code}: ${request.detail}`,
        tokenCounts,
      };
    }

    const result = await provider.decide(request.value);
    if (!result.ok) {
      return {
        status: 'failed',
        predictedCategoryId: null,
        predictedDestinationId: null,
        route,
        error: `${result.code}: ${result.detail}`,
        tokenCounts,
      };
    }
    const decision = result.value;
    mergeTokenCounts(tokenCounts, decision.tokenCounts);
    const answer = decision.answers[0];
    if (answer === undefined) {
      return {
        status: 'failed',
        predictedCategoryId: null,
        predictedDestinationId: null,
        route,
        error: `provider returned no answers: ${decision.error ?? 'unknown'}`,
        tokenCounts,
      };
    }
    route.push({ nodeId: node.id, questionId: answer.questionId, selectedId: answer.selectedId, probabilities: answer.probabilities });

    if (answer.selectedId === UNKNOWN_OPTION_ID) {
      // Unknown, malformed output, insufficient evidence or provider failure
      // produces no executable proposal (FR-05): an explicit deferral.
      return { status: 'deferred', predictedCategoryId: null, predictedDestinationId: null, route, error: null, tokenCounts };
    }

    const child = children.find((candidate) => candidate.id === answer.selectedId);
    if (child === undefined) {
      return {
        status: 'failed',
        predictedCategoryId: null,
        predictedDestinationId: null,
        route,
        error: `provider selected ${JSON.stringify(answer.selectedId)}, which is not an option`,
        tokenCounts,
      };
    }
    if (child.kind === 'existing') {
      return {
        status: 'completed',
        predictedCategoryId: child.id,
        predictedDestinationId: child.destinationId,
        route,
        error: null,
        tokenCounts,
      };
    }
    node = child;
  }

  return {
    status: 'deferred',
    predictedCategoryId: null,
    predictedDestinationId: null,
    route,
    error: 'route did not reach an existing category within four levels',
    tokenCounts,
  };
}

/** Runs the full-route evaluation for every (item, provider) pair, serially. */
export async function runEvaluation(
  dataset: EvalDataset,
  providers: readonly DecisionProvider[],
  config: EvalConfig,
): Promise<EvalRun> {
  const split = config.split;
  const items = dataset.items.filter((item) => split === 'all' || item.split === split);
  const predictions: PredictionRow[] = [];
  const providerRuns: ProviderRun[] = [];
  const warmRepeats = config.warmRepeats ?? 3;

  for (const provider of providers) {
    const providerStarted = Date.now();
    const health = await provider.health();

    if (!health.ok) {
      // Health failure blocks that provider's evaluation without dropping
      // it from reported results: every item is a recorded failure.
      providerRuns.push({
        provider: providerNameOf(provider),
        modelRevision: 'unknown',
        runtimeRevision: 'unknown',
        status: 'blocked',
        manifest: null,
        blockedDetail: `${health.code}: ${health.detail}`,
        elapsedTotalMs: 0,
        warmedSamples: [],
        warmRepeats: 0,
      });
      for (const item of items) {
        predictions.push({
          itemId: item.itemId,
          familyId: item.familyId,
          split: item.split,
          provider: providerNameOf(provider),
          modelRevision: 'unknown',
          runtimeRevision: 'unknown',
          evidenceProfile: config.evidenceTreatment,
          status: 'failed',
          predictedCategoryId: null,
          predictedDestinationId: null,
          route: [],
          error: `provider blocked: ${health.code}: ${health.detail}`,
          elapsedMs: 0,
          tokenCounts: {},
        });
      }
      continue;
    }

    const manifest = health.value;
    const manifests = [manifest];
    const warmedSamples: number[] = [];

    for (let warm = 0; warm < warmRepeats; warm++) {
      for (const item of items) {
        const started = Date.now();
        await runRoute(treatEvidence(item.evidence, config.evidenceTreatment), dataset.taxonomy, manifests, provider);
        warmedSamples.push(Date.now() - started);
      }
    }

    // The evaluation (and predictions) use the final warmed pass.
    for (const item of items) {
      const evidence = treatEvidence(item.evidence, config.evidenceTreatment);
      const started = Date.now();
      const outcome = await runRoute(evidence, dataset.taxonomy, manifests, provider);
      predictions.push({
        itemId: item.itemId,
        familyId: item.familyId,
        split: item.split,
        provider: manifest.provider,
        modelRevision: manifest.modelRevision,
        runtimeRevision: manifest.runtimeRevision,
        evidenceProfile: config.evidenceTreatment,
        status: outcome.status,
        predictedCategoryId: outcome.predictedCategoryId,
        predictedDestinationId: outcome.predictedDestinationId,
        route: outcome.route,
        error: outcome.error,
        elapsedMs: Date.now() - started,
        tokenCounts: outcome.tokenCounts,
      });
    }

    providerRuns.push({
      provider: manifest.provider,
      modelRevision: manifest.modelRevision,
      runtimeRevision: manifest.runtimeRevision,
      status: 'ok',
      manifest,
      blockedDetail: null,
      elapsedTotalMs: Date.now() - providerStarted,
      warmedSamples,
      warmRepeats,
    });
  }

  return {
    datasetHash: dataset.datasetHash,
    taxonomyHash: dataset.taxonomyHash,
    splitSeed: dataset.manifest.splitSeed,
    evidenceTreatment: config.evidenceTreatment,
    split,
    synthetic: true,
    predictions,
    nodePredictions: [],
    providerRuns,
  };
}

function providerNameOf(provider: DecisionProvider): ProviderId {
  const name = provider.constructor.name.toLowerCase();
  if (name.includes('rules')) return 'rules';
  if (name.includes('laya')) return 'laya';
  if (name.includes('clef')) return 'clef';
  if (name.includes('jev')) return 'jev';
  return 'jev';
}

/**
 * Teacher-forced node calibration (docs/05 §5): each item is evaluated at
 * the nodes along its TRUE route, so upstream mistakes cannot contaminate
 * local probability metrics. Labels enter ONLY here (they select the
 * question, never the evidence state); the distinction from the model's own
 * full-route prediction stays explicit in reports.
 */
export async function appendNodeCalibration(
  run: EvalRun,
  dataset: EvalDataset,
  providers: readonly DecisionProvider[],
  labels: EvalLabels,
  options: { evidenceTreatment: EvalConfig['evidenceTreatment'] },
): Promise<EvalRun> {
  const nodePredictions = [...run.nodePredictions];

  for (const item of dataset.items) {
    const label: EvalLabel | undefined = labels.labels[item.itemId];
    if (label === undefined) continue;

    // True route: root -> ... -> primary category.
    const byId = new Map(dataset.taxonomy.tree.map((category) => [category.id, category]));
    const truePath: Category[] = [];
    let current: Category | undefined = byId.get(label.primaryCategoryId);
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current.id)) {
      truePath.unshift(current);
      seen.add(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }

    for (let i = 0; i + 1 < truePath.length; i++) {
      const node = truePath[i];
      const trueChild = truePath[i + 1];
      if (node === undefined || trueChild === undefined) continue;
      const children = childrenOf(dataset.taxonomy.tree, node.id);

      for (const provider of providers) {
        const health = await provider.health();
        if (!health.ok) continue;
        const request = buildMatchedRequest(treatEvidence(item.evidence, options.evidenceTreatment), { category: node, children }, [health.value]);
        if (!request.ok) continue;
        const result = await provider.decide(request.value);
        if (!result.ok) continue;
        const answer = result.value.answers[0];
        if (answer === undefined) continue;
        nodePredictions.push({
          itemId: item.itemId,
          familyId: item.familyId,
          provider: health.value.provider,
          nodeId: node.id,
          questionId: answer.questionId,
          trueOptionId: trueChild.id,
          selectedId: answer.selectedId,
          probabilities: answer.probabilities,
        });
      }
    }
  }

  return { ...run, nodePredictions };
}
