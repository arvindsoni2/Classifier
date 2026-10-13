/**
 * Rendering for catalogue reports (plan Task 5): plain text writers, no I/O.
 *
 * Everything here turns data that `report.ts` has already read into the two
 * human-facing forms. Two rules govern both writers:
 *
 *  - **A name is data.** A filename may contain a comma, a quote, a newline or
 *    non-ASCII characters. CSV quoting follows RFC 4180 minimally — a field is
 *    quoted only when it has to be, and quotes inside it are doubled — and
 *    Markdown table cells have their pipes and line breaks escaped. Nothing is
 *    stripped, truncated or transliterated.
 *  - **Numbers stay exact.** Bytes are grouped for reading (`1,234,567`) but
 *    never rounded or abbreviated, because a reviewer compares them with `du`.
 */
import type { DuplicateGroup } from './dedupe.js';
import type { ReportSummary } from './report-summary.js';

/** Row shapes the writers consume; `report.ts` is what produces them. */
export interface ScanRow {
  id: number;
  status: string;
  started_at: string;
  finished_at: string | null;
  files_seen: number;
  dirs_seen: number;
  bytes_seen: number;
  files_hashed: number;
  errors: number;
}

export interface ItemRow {
  root_path: string;
  rel_path: string;
  size: number;
  kind: string;
  status: string;
  mtime_ns: string;
  bundle_type: string | null;
}

export interface BundleRow {
  root_path: string;
  rel_path: string;
  type: string;
  parent_path: string | null;
  member_count: number | null;
  total_size: number | null;
  rule: string;
}

export interface ErrorRow {
  root_path: string;
  rel_path: string;
  code: string;
  message: string;
}

/** How many rows the Markdown sections keep, per the plan. */
export const LARGEST_FILES_IN_SUMMARY = 20;
export const LARGEST_GROUPS_IN_SUMMARY = 30;
export const LARGEST_BUNDLES_PER_TYPE = 10;

// --- CSV ---------------------------------------------------------------------

/**
 * Minimal RFC 4180 quoting: quote only when the field contains a comma, a quote
 * or a line break, and double any quote inside. Non-ASCII passes through as
 * UTF-8.
 */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /["\n\r,]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvLine(fields: readonly (string | number | null | undefined)[]): string {
  return fields.map((field) => csvField(field)).join(',');
}

/** The ISO instant a nanosecond mtime records. */
function isoFromNs(mtimeNs: string): string {
  return new Date(Number(BigInt(mtimeNs) / 1_000_000n)).toISOString();
}

/** One row per group member; every group is listed, not only the largest. */
export function renderDuplicatesCsv(groups: DuplicateGroup[], items: ItemRow[]): string {
  const byPath = new Map(items.map((item) => [itemPath(item.root_path, item.rel_path), item]));
  const lines = ['group,sha256,size,wasted_bytes,root,rel_path,mtime,bundle_type'];
  groups.forEach((group, index) => {
    for (const member of group.items) {
      const item = byPath.get(itemPath(member.rootPath, member.relPath));
      lines.push(
        csvLine([
          index + 1,
          group.sha256,
          group.size,
          group.wastedBytes,
          member.rootPath,
          member.relPath,
          item === undefined ? '' : isoFromNs(item.mtime_ns),
          item?.bundle_type ?? '',
        ]),
      );
    }
  });
  return `${lines.join('\n')}\n`;
}

export function renderBundlesCsv(bundles: BundleRow[]): string {
  const lines = ['type,root,rel_path,members,total_size,rule,parent'];
  for (const bundle of bundles) {
    lines.push(
      csvLine([
        bundle.type,
        bundle.root_path,
        bundle.rel_path,
        bundle.member_count,
        bundle.total_size,
        bundle.rule,
        bundle.parent_path,
      ]),
    );
  }
  return `${lines.join('\n')}\n`;
}

export function renderErrorsCsv(errors: ErrorRow[]): string {
  const lines = ['root,rel_path,code,message'];
  for (const error of errors) lines.push(csvLine([error.root_path, error.rel_path, error.code, error.message]));
  return `${lines.join('\n')}\n`;
}

// --- Markdown ----------------------------------------------------------------

/** Absolute path of an item, as every report section prints it. */
export function itemPath(root: string, relPath: string): string {
  return `${root}/${relPath}`;
}

/** Keeps a name inside one table cell: no pipes, no line breaks. */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value).replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
}

function table(headers: readonly string[], rows: readonly (readonly (string | number | null)[])[]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map((value) => cell(value)).join(' | ')} |`),
  ].join('\n');
}

/** `1234567` -> `1,234,567`: exact, and easier to check against `du`. */
export function bytes(value: number): string {
  return value.toLocaleString('en-US');
}

function renderRows(
  headers: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
  empty = '_None._',
): string {
  return rows.length === 0 ? empty : table(headers, rows);
}

function renderBundles(summary: ReportSummary): string {
  if (summary.bundles.total === 0) return '_None._';
  return [
    `${summary.bundles.total} bundles detected.`,
    '',
    table(
      ['Type', 'Count', 'Total size'],
      summary.bundles.byType.map((row) => [row.type, row.count, bytes(row.totalSize)]),
    ),
    '',
    `Largest of each type (up to ${LARGEST_BUNDLES_PER_TYPE}):`,
    '',
    table(
      ['Type', 'Path', 'Members', 'Total size'],
      summary.bundles.largest.map((bundle) => [
        bundle.type,
        bundle.path,
        bundle.members,
        bundle.totalSize === null ? '' : bytes(bundle.totalSize),
      ]),
    ),
  ].join('\n');
}

function renderDuplicates(summary: ReportSummary): string {
  const { groups, wastedBytes, largest } = summary.duplicates;
  if (groups === 0) return '_None._';
  return [
    `${groups} duplicate groups, wasted ${bytes(wastedBytes)} bytes.`,
    `Showing the ${largest.length} largest of them.`,
    '',
    table(
      ['Wasted', 'Size', 'Copies', 'SHA-256'],
      largest.map((group) => [bytes(group.wastedBytes), bytes(group.size), group.copies, group.sha256]),
    ),
  ].join('\n');
}

export function renderMarkdown(summary: ReportSummary): string {
  const scan = summary.scan;
  return [
    '# Catalogue summary',
    [
      `Scan ${scan.id} (${scan.status}), started ${scan.startedAt ?? 'unknown'}.`,
      `Duration: ${(scan.durationMs / 1000).toFixed(1)}s.`,
      `Files hashed: ${scan.filesHashed}.`,
      '',
      `${scan.filesSeen} files in ${scan.dirsSeen} directories, ${bytes(scan.bytesSeen)} bytes, ` +
        `${scan.errors} errors.`,
    ].join('\n'),
    `## Totals per root\n\n${renderRows(
      ['Root', 'Files', 'Bytes'],
      summary.roots.map((root) => [root.path, root.files, bytes(root.bytes)]),
    )}`,
    `## Counts per kind\n\n${renderRows(
      ['Kind', 'Files', 'Bytes'],
      summary.kinds.map((kind) => [kind.kind, kind.files, bytes(kind.bytes)]),
    )}`,
    `## Bundles\n\n${renderBundles(summary)}`,
    `## Largest files\n\n${renderRows(
      ['Size', 'Kind', 'Path'],
      summary.largestFiles.map((file) => [bytes(file.size), file.kind, file.path]),
    )}`,
    `## Duplicate groups\n\n${renderDuplicates(summary)}`,
    `## Incomplete files\n\n${renderRows(
      ['Size', 'Path'],
      summary.incomplete.map((file) => [bytes(file.size), file.path]),
    )}`,
    `## Errors by code\n\n${renderRows(
      ['Code', 'Count'],
      summary.errors.map((error) => [error.code, error.count]),
    )}`,
  ]
    .join('\n\n')
    .concat('\n');
}