/**
 * Frozen evaluation dataset (docs/05, plan Task 5): manifest, items and
 * labels are file contracts; labels never enter inference state. Split
 * assignment is family-aware (duplicate families stay together) and
 * deterministic under the split seed 20261006.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  stableStringify,
  type Category,
  type Destination,
  type Evidence,
  type Result,
} from '../domain/contracts.js';

export const SPLIT_SEED = 20261006;
export const SPLIT_PROTOTYPES = [
  { name: 'development', share: 0.3 }, // 60/200 target
  { name: 'calibration', share: 0.2 }, // 40/200 target
  { name: 'test', share: 0.5 }, // 100/200 target
] as const;

export type SplitName = (typeof SPLIT_PROTOTYPES)[number]['name'];

export interface EvalItem {
  itemId: string;
  externalId: string;
  familyId: string;
  evidence: Evidence;
  split: SplitName;
}

export interface EvalTaxonomy {
  tree: Category[];
  destinations: Destination[];
}

export interface EvalManifest {
  schemaVersion: string;
  datasetHash: string;
  taxonomyHash: string;
  policyHash: string;
  splitSeed: number;
  extractorRevision: string;
  evidenceTreatment: string;
  sourceRevisions: string[];
  machine: {
    synthetic: boolean;
    cpus?: number;
    totalMemoryBytes?: number;
    cpuModel?: string;
    gpu?: string | null;
  };
  consentId?: string | null;
}

export interface EvalDataset {
  manifest: EvalManifest;
  taxonomy: EvalTaxonomy;
  items: EvalItem[];
  /** Content hash of the frozen items (canonical JSON). */
  datasetHash: string;
  /** Content hash of the frozen taxonomy (tree + destinations). */
  taxonomyHash: string;
}

export interface EvalLabel {
  itemId: string;
  /** Preferred primary destination label (the user's placement preference). */
  primaryCategoryId: string;
  acceptableCategoryIds: string[];
  sufficientEvidence: boolean;
  newFolderState: 'reuse_existing' | 'new_folder_justified' | 'insufficient_evidence';
}

export interface EvalLabels {
  labels: Record<string, EvalLabel>;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Deterministic family-aware split: identical families share a split. */
export function assignSplits(
  items: readonly { itemId: string; familyId: string }[],
  seed: number = SPLIT_SEED,
): Record<string, SplitName> {
  const families = [...new Set(items.map((item) => item.familyId))].sort((a, b) => (a < b ? -1 : 1));
  const assignment: Record<string, SplitName> = {};
  for (const familyId of families) {
    const bucket = sha256(`${seed}:${familyId}`)
      .slice(0, 8);
    const value = Number.parseInt(bucket, 16) / 0xffffffff;
    const split: SplitName =
      value < 0.3 ? 'development' : value < 0.5 ? 'calibration' : 'test';
    for (const item of items) {
      if (item.familyId === familyId) assignment[item.itemId] = split;
    }
  }
  return assignment;
}

interface ItemLine {
  itemId: string;
  externalId: string;
  familyId: string;
  evidence: {
    id: string;
    itemId: string;
    profile: 'metadata' | 'compact_text';
    state: Record<string, unknown>;
    stateHash?: string;
    status: 'ready' | 'metadata_only' | 'failed';
    truncated: boolean;
    extractorRevision: string;
    inputTokenCounts: Record<string, number>;
  };
}

function readJsonl(path: string): unknown[] {
  const content = readFileSync(path, 'utf8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

/** Content hash over the frozen items (canonical JSON). */
export function datasetHashOf(items: readonly EvalItem[]): string {
  return sha256(
    stableStringify(
      items.map((item) => ({
        itemId: item.itemId,
        familyId: item.familyId,
        externalId: item.externalId,
        state: item.evidence.state,
      })),
    ),
  );
}

/** Content hash over the frozen taxonomy (tree + destinations). */
export function taxonomyFeatureHash(taxonomy: EvalTaxonomy): string {
  return sha256(stableStringify({ tree: taxonomy.tree, destinations: taxonomy.destinations }));
}

/** Loads a frozen dataset directory: manifest.json + items.jsonl + taxonomy.json. */
export function loadDataset(dir: string): Result<EvalDataset> {
  let manifest: EvalManifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as EvalManifest;
  } catch (error) {
    return { ok: false, code: 'INVALID_DECISION', detail: `manifest.json unreadable: ${(error as Error).message}` };
  }
  let taxonomy: EvalTaxonomy;
  try {
    taxonomy = JSON.parse(readFileSync(join(dir, 'taxonomy.json'), 'utf8')) as EvalTaxonomy;
  } catch (error) {
    return { ok: false, code: 'INVALID_DECISION', detail: `taxonomy.json unreadable: ${(error as Error).message}` };
  }
  let itemLines: ItemLine[];
  try {
    itemLines = readJsonl(join(dir, 'items.jsonl')) as ItemLine[];
  } catch (error) {
    return { ok: false, code: 'INVALID_DECISION', detail: `items.jsonl unreadable: ${(error as Error).message}` };
  }
  if (itemLines.length === 0) {
    return { ok: false, code: 'INVALID_DECISION', detail: 'dataset has no items' };
  }
  const seen = new Set<string>();
  const items: EvalItem[] = [];
  for (const line of itemLines) {
    if (seen.has(line.itemId)) {
      return { ok: false, code: 'INVALID_DECISION', detail: `items.jsonl contains duplicate itemId ${line.itemId}` };
    }
    seen.add(line.itemId);
    const evidence: Evidence = {
      ...line.evidence,
      stateHash: line.evidence.stateHash ?? sha256(stableStringify(line.evidence.state)),
    };
    items.push({
      itemId: line.itemId,
      externalId: line.externalId,
      familyId: line.familyId,
      evidence,
      split: 'development',
    });
  }

  const splits = assignSplits(items, manifest.splitSeed);
  for (const item of items) {
    item.split = splits[item.itemId] ?? 'development';
  }

  const datasetHash = datasetHashOf(items);
  const taxonomyHash = taxonomyFeatureHash(taxonomy);

  // A frozen dataset's manifest is authoritative: a mismatching hash means
  // drift or tampering, never something to paper over.
  if (manifest.datasetHash !== datasetHash || manifest.taxonomyHash !== taxonomyHash) {
    return {
      ok: false,
      code: 'INVALID_DECISION',
      detail:
        'manifest hash mismatch: the dataset/taxonomy contents do not match manifest.datasetHash/taxonomyHash ' +
        `(computed ${datasetHash.slice(0, 12)}…/${taxonomyHash.slice(0, 12)}…, expected ${manifest.datasetHash.slice(0, 12)}…/${manifest.taxonomyHash.slice(0, 12)}…)`,
    };
  }

  return { ok: true, value: { manifest, taxonomy, items, datasetHash, taxonomyHash } };
}

/** Loads labels.jsonl; labels stay outside EvalDataset so they cannot leak into inference. */
export function loadLabels(dir: string): { ok: true; value: EvalLabels } | {
  ok: false;
  code: 'INVALID_DECISION';
  detail: string;
} {
  try {
    const lines = readJsonl(join(dir, 'labels.jsonl')) as EvalLabel[];
    const labels: Record<string, EvalLabel> = {};
    for (const label of lines) labels[label.itemId] = label;
    return { ok: true, value: { labels } };
  } catch (error) {
    return { ok: false, code: 'INVALID_DECISION', detail: `labels.jsonl unreadable: ${(error as Error).message}` };
  }
}

export function itemFeatureHash(items: readonly EvalItem[]): string {
  return datasetHashOf(items);
}
