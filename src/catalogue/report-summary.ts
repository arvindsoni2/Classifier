/**
 * The shape of a report's machine-readable figures.
 *
 * Kept in its own module because both halves of the reporting stage need it and
 * neither should own it: `report.ts` builds these figures, `report-format.ts`
 * renders them, `cli.ts` prints them.
 */
import type { BundleType } from './store.js';

export interface ReportSummary {
  scan: {
    id: number;
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number;
    filesSeen: number;
    dirsSeen: number;
    bytesSeen: number;
    filesHashed: number;
    errors: number;
  };
  /**
   * Every root the scan covered, whether or not it was reachable. An offline or
   * probe-failed root is listed with the figures from its last successful scan,
   * and says so: an unplugged or unprobed drive must never read as an empty one.
   */
  roots: {
    path: string;
    status: 'online' | 'offline' | 'probe_failed';
    fstype: string | null;
    files: number;
    bytes: number;
  }[];
  kinds: { kind: string; files: number; bytes: number }[];
  bundles: {
    total: number;
    byType: { type: BundleType; count: number; totalSize: number }[];
    largest: { type: BundleType; path: string; members: number | null; totalSize: number | null }[];
  };
  largestFiles: { path: string; size: number; kind: string }[];
  duplicates: {
    groups: number;
    wastedBytes: number;
    largest: { rank: number; sha256: string; size: number; copies: number; wastedBytes: number }[];
  };
  incomplete: { path: string; size: number }[];
  errors: { code: string; count: number }[];

  /** Stored metadata outcomes for the present items of this scan, per extractor.
   * Counts what is in the catalogue, not what ran this run: a `failed` row from an
   * earlier scan still counts as `failed` here because it is settled. */
  metadata: MetadataSummary;
}

/** One extractor's stored outcomes, and the four figures a report prints for it. */
export interface MetadataOutcomes {
  ok: number;
  failed: number;
  timeout: number;
  unavailable: number;
}

export interface MetadataSummary {
  /** Every stored row for the present items of this scan, all extractors together. */
  stored: MetadataOutcomes;
  /** The same rows split by extractor. An extractor with no row is absent. */
  byExtractor: Record<string, MetadataOutcomes>;
}

/** One row of the metadata aggregate: how many rows an extractor has in a status. */
export interface MetadataOutcomeRow {
  extractor: string;
  status: string;
  count: number;
}

const OUTCOME_STATUSES: readonly (keyof MetadataOutcomes)[] = ['ok', 'failed', 'timeout', 'unavailable'];

function emptyOutcomes(): MetadataOutcomes {
  return { ok: 0, failed: 0, timeout: 0, unavailable: 0 };
}

/**
 * Folds the metadata aggregate into totals and per-extractor figures.
 *
 * A status outside the four known ones is counted nowhere rather than being
 * invented as a fifth column: `metadata.status` is a CHECK constraint, so an
 * unknown value means the schema and this module disagree, and that should be
 * visible rather than silently folded into `ok`.
 */
export function summariseMetadata(rows: readonly MetadataOutcomeRow[]): MetadataSummary {
  const stored = emptyOutcomes();
  const byExtractor = new Map<string, MetadataOutcomes>();
  for (const row of rows) {
    const status = OUTCOME_STATUSES.find((candidate) => candidate === row.status);
    if (status === undefined) continue;
    const bucket = byExtractor.get(row.extractor) ?? emptyOutcomes();
    bucket[status] += Number(row.count);
    stored[status] += Number(row.count);
    byExtractor.set(row.extractor, bucket);
  }
  return { stored, byExtractor: Object.fromEntries(byExtractor) };
}