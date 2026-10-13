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
  roots: { path: string; files: number; bytes: number }[];
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
}