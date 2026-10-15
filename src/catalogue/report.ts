/**
 * Catalogue reports (plan Task 5).
 *
 * One scan becomes one directory of plain files: a Markdown summary a person
 * reads, three CSVs a spreadsheet opens, and a `summary.json` with the same
 * numbers for review or diffing. Everything here reads the catalogue; the only
 * writes are into the data directory, never into a scanned root
 * (AGENTS.md rule 4).
 *
 * The figures are about **one scan**. Items, bundles, errors and duplicate
 * groups are all restricted to what that scan catalogued, so a report never
 * mixes a stale row from an earlier run into its totals. Rendering lives in
 * `report-format.ts`; this module is the part that knows what the rows mean.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { duplicateGroups, type DuplicateGroup } from './dedupe.js';
import {
  itemPath,
  LARGEST_BUNDLES_PER_TYPE,
  LARGEST_FILES_IN_SUMMARY,
  LARGEST_GROUPS_IN_SUMMARY,
  renderBundlesCsv,
  renderDuplicatesCsv,
  renderErrorsCsv,
  renderMarkdown,
  type BundleRow,
  type ErrorRow,
  type ItemRow,
  type ScanRow,
} from './report-format.js';
import type { ReportSummary } from './report-summary.js';
import type { BundleType, CatalogueStore } from './store.js';

export type { ReportSummary } from './report-summary.js';

export interface ReportResult {
  /** `<dataDir>/reports/<scanId>-<yyyymmdd-hhmm>`. */
  dir: string;
  /** File names written, in a stable order. */
  files: string[];
  summary: ReportSummary;
}

/** Everything one scan's report is built from, read once and reused. */
interface ReportData {
  scan: ScanRow;
  roots: RootFigures[];
  items: ItemRow[];
  bundles: BundleRow[];
  errors: ErrorRow[];
  duplicates: DuplicateGroup[];
}

/** One root's line in a report: what it is, and what it holds. */
interface RootFigures {
  path: string;
  status: 'online' | 'offline';
  fstype: string | null;
  files: number;
  bytes: number;
}

/**
 * `<dataDir>/reports/<scanId>-<yyyymmdd-hhmm>`. The scan id keeps two reports in
 * the same minute apart; the timestamp is UTC, so a report is identical wherever
 * it is generated — which is what makes two review copies comparable.
 */
export function reportDirFor(dataDir: string, scanId: number, at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  return join(dataDir, 'reports', `${scanId}-${stamp}`);
}

/** The most recent scan that finished, whatever its status, or undefined. */
export function latestFinishedScan(store: CatalogueStore): number | undefined {
  const row = store.db
    .prepare("SELECT id FROM scans WHERE status IN ('done', 'failed') ORDER BY id DESC LIMIT 1")
    .get() as { id: number } | undefined;
  return row?.id;
}

/** Reads one scan's rows. Every report figure comes from here, and nowhere else. */
function readReportData(store: CatalogueStore, scanId: number): ReportData {
  const scan = store.db.prepare('SELECT * FROM scans WHERE id = ?').get(scanId) as ScanRow | undefined;
  if (scan === undefined) throw new Error(`scan ${scanId} is not in this catalogue`);

  const items = store.db
    .prepare(
      `SELECT r.path AS root_path, i.rel_path, i.size, i.kind, i.status, i.mtime_ns, b.type AS bundle_type
       FROM items i JOIN roots r ON r.id = i.root_id
       LEFT JOIN bundles b ON b.id = i.bundle_id
       WHERE i.status <> 'missing' AND i.last_seen_scan = @scanId
       ORDER BY r.path, i.rel_path`,
    )
    .all({ scanId }) as ItemRow[];

  const bundles = store.db
    .prepare(
      `SELECT r.path AS root_path, b.rel_path, b.type, p.rel_path AS parent_path,
              b.member_count, b.total_size, b.rule
       FROM bundles b JOIN roots r ON r.id = b.root_id
       LEFT JOIN bundles p ON p.id = b.parent_bundle_id
       WHERE b.detected_scan = @scanId
       ORDER BY r.path, b.rel_path`,
    )
    .all({ scanId }) as BundleRow[];

  const errors = store.db
    .prepare(
      `SELECT r.path AS root_path, e.rel_path, e.code, e.message
       FROM scan_errors e JOIN roots r ON r.id = e.root_id
       WHERE e.scan_id = @scanId
       ORDER BY r.path, e.rel_path, e.id`,
    )
    .all({ scanId }) as ErrorRow[];

  return { scan, roots: readRoots(store, scanId, items), items, bundles, errors, duplicates: duplicateGroups(store, scanId) };
}

/**
 * Every root this scan covered, from `scan_roots` — the table written whether or
 * not the root could be reached — and not from the items it happened to see.
 *
 * That distinction is the whole point: an offline root's items keep an older
 * `last_seen_scan`, so counting roots from the items silently drops an unplugged
 * drive out of the totals and reads as a drive that lost everything.
 *
 * An online root's figures are this scan's; an offline root's are its `present`
 * items from whenever they were last seen, which is the last trustworthy thing
 * known about it. Its filesystem type is the last one recorded, because a drive
 * that is away cannot be asked, and "which drive is missing" is worth answering.
 *
 * A scan with no `scan_roots` rows predates the table, or ran without a volume
 * probe; those fall back to the roots its items came from, which is what every
 * report did before volumes existed.
 */
function readRoots(store: CatalogueStore, scanId: number, items: ItemRow[]): RootFigures[] {
  const perScan = new Map<string, { files: number; bytes: number }>();
  for (const item of items) {
    const totals = perScan.get(item.root_path) ?? { files: 0, bytes: 0 };
    totals.files += 1;
    totals.bytes += item.size;
    perScan.set(item.root_path, totals);
  }

  const covered = store.db
    .prepare(
      `SELECT sr.path, sr.status, COALESCE(sr.fstype, r.fstype) AS fstype, sr.root_id AS rootId
       FROM scan_roots sr JOIN roots r ON r.id = sr.root_id
       WHERE sr.scan_id = @scanId
       ORDER BY sr.path`,
    )
    .all({ scanId }) as { path: string; status: 'online' | 'offline'; fstype: string | null; rootId: number }[];

  if (covered.length === 0) {
    return [...perScan.entries()].map(([path, totals]) => ({
      path,
      status: 'online' as const,
      fstype: null,
      ...totals,
    }));
  }

  const presentItems = store.db.prepare(
    `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes
     FROM items WHERE root_id = ? AND status = 'present'`,
  );
  return covered.map((root) => {
    const totals =
      root.status === 'offline'
        ? (presentItems.get(root.rootId) as { files: number; bytes: number })
        : (perScan.get(root.path) ?? { files: 0, bytes: 0 });
    return { path: root.path, status: root.status, fstype: root.fstype, files: totals.files, bytes: totals.bytes };
  });
}

/**
 * The figures a report would contain, without writing anything. `stats` prints
 * these; a report writes them.
 */
export function reportSummary(store: CatalogueStore, scanId: number): ReportSummary {
  const data = readReportData(store, scanId);
  return buildSummary(data.scan, data.roots, data.items, data.bundles, data.errors, data.duplicates);
}

/** Writes every report file for `scanId` under `dataDir`. */
export function writeReport(store: CatalogueStore, scanId: number, dataDir: string): ReportResult {
  const data = readReportData(store, scanId);
  const summary = buildSummary(data.scan, data.roots, data.items, data.bundles, data.errors, data.duplicates);

  const dir = reportDirFor(dataDir, scanId, new Date(data.scan.started_at));
  mkdirSync(dir, { recursive: true });
  const files = ['summary.md', 'summary.json', 'duplicates.csv', 'bundles.csv', 'errors.csv'];
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'summary.md'), renderMarkdown(summary), 'utf8');
  writeFileSync(join(dir, 'duplicates.csv'), renderDuplicatesCsv(data.duplicates, data.items), 'utf8');
  writeFileSync(join(dir, 'bundles.csv'), renderBundlesCsv(data.bundles), 'utf8');
  writeFileSync(join(dir, 'errors.csv'), renderErrorsCsv(data.errors), 'utf8');
  return { dir, files, summary };
}

function buildSummary(
  scan: ScanRow,
  roots: RootFigures[],
  items: ItemRow[],
  bundles: BundleRow[],
  errors: ErrorRow[],
  duplicates: DuplicateGroup[],
): ReportSummary {
  // Only the per-kind figures come from the items: the roots are already known,
  // and an offline root holds no items from this scan to count (see `readRoots`).
  const kinds = new Map<string, { kind: string; files: number; bytes: number }>();
  for (const item of items) {
    const kind = kinds.get(item.kind) ?? { kind: item.kind, files: 0, bytes: 0 };
    kind.files += 1;
    kind.bytes += item.size;
    kinds.set(item.kind, kind);
  }

  const byType = new Map<BundleType, { type: BundleType; count: number; totalSize: number }>();
  const largestByType = new Map<BundleType, BundleRow[]>();
  for (const bundle of bundles) {
    const row = byType.get(bundle.type as BundleType) ?? {
      type: bundle.type as BundleType,
      count: 0,
      totalSize: 0,
    };
    row.count += 1;
    row.totalSize += bundle.total_size ?? 0;
    byType.set(row.type, row);
    const list = largestByType.get(row.type) ?? [];
    list.push(bundle);
    largestByType.set(row.type, list);
  }

  const errorCounts = new Map<string, number>();
  for (const error of errors) {
    errorCounts.set(error.code, (errorCounts.get(error.code) ?? 0) + 1);
  }

  return {
    scan: {
      id: scan.id,
      status: scan.status,
      startedAt: scan.started_at,
      finishedAt: scan.finished_at,
      durationMs: durationOf(scan),
      filesSeen: scan.files_seen,
      dirsSeen: scan.dirs_seen,
      bytesSeen: scan.bytes_seen,
      filesHashed: scan.files_hashed,
      errors: scan.errors,
    },
    roots: roots.slice().sort((a, b) => b.bytes - a.bytes),
    kinds: [...kinds.values()].sort((a, b) => b.bytes - a.bytes),
    bundles: {
      total: bundles.length,
      byType: [...byType.values()].sort((a, b) => b.count - a.count),
      largest: [...largestByType.values()]
        .flatMap((list) =>
          list
            .slice()
            .sort((a, b) => (b.total_size ?? 0) - (a.total_size ?? 0))
            .slice(0, LARGEST_BUNDLES_PER_TYPE)
            .map((bundle) => ({
              type: bundle.type as BundleType,
              path: itemPath(bundle.root_path, bundle.rel_path),
              members: bundle.member_count,
              totalSize: bundle.total_size,
            })),
        )
        .sort((a, b) => (b.totalSize ?? 0) - (a.totalSize ?? 0)),
    },
    largestFiles: items
      .slice()
      .sort((a, b) => b.size - a.size || a.rel_path.localeCompare(b.rel_path))
      .slice(0, LARGEST_FILES_IN_SUMMARY)
      .map((item) => ({ path: itemPath(item.root_path, item.rel_path), size: item.size, kind: item.kind })),
    duplicates: {
      groups: duplicates.length,
      wastedBytes: duplicates.reduce((total, group) => total + group.wastedBytes, 0),
      largest: duplicates
        .slice(0, LARGEST_GROUPS_IN_SUMMARY)
        .map((group, index) => ({
          rank: index + 1,
          sha256: group.sha256,
          size: group.size,
          copies: group.copies,
          wastedBytes: group.wastedBytes,
        })),
    },
    incomplete: items
      .filter((item) => item.status === 'incomplete')
      .map((item) => ({ path: itemPath(item.root_path, item.rel_path), size: item.size })),
    errors: [...errorCounts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
  };
}

/** Elapsed milliseconds, or 0 when a scan never finished. */
function durationOf(scan: ScanRow): number {
  const started = Date.parse(scan.started_at);
  const finished = scan.finished_at === null ? Number.NaN : Date.parse(scan.finished_at);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return 0;
  return Math.max(0, finished - started);
}