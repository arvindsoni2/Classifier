/**
 * Metadata extraction for a finished scan (plan Task 4).
 *
 * Five extractors, one row per item and extractor, four possible statuses. The
 * rules that keep this pass cheap and safe on someone's real filesystem:
 *
 *  - **Nothing is extracted twice.** An item whose row already says `ok` keeps
 *    it, and a changed item loses its rows during the scan itself (see
 *    `CatalogueStore.upsertItems`), so "has a row" and "is current" are the
 *    same thing. A rescan of an unchanged tree does no extraction at all.
 *  - **Availability is asked once per extractor per scan.** A machine without
 *    `ffprobe` records `unavailable` for its audio files instead of failing
 *    each one, and does not re-probe for every file.
 *  - **Failures are rows, not crashes.** A malformed EPUB, a refused zip bomb
 *    or a tool that overruns its deadline becomes a status on that item; every
 *    other item still gets its turn.
 *  - **Two extractions at a time, ten seconds each, 1 MiB of output.** Set by
 *    the plan so a pathological file cannot stall a scan of a large root.
 *
 * Everything here is read-only on the roots (AGENTS.md rule 4): the only writes
 * are catalogue rows.
 */
import type { Kind } from '../kinds.js';
import type { CatalogueStore } from '../store.js';
import { epubExtractor } from './epub.js';
import { exifExtractor } from './exif.js';
import { ffprobeExtractor } from './ffprobe.js';
import { officeExtractor } from './office.js';
import { pdfinfoExtractor } from './pdfinfo.js';
import type { Extractor } from './types.js';

export type MetadataStatus = 'ok' | 'unavailable' | 'failed' | 'timeout';

export type { Extractor } from './types.js';

/** Deadline for one extraction, per the plan. */
export const EXTRACTION_TIMEOUT_MS = 10_000;

/** Extractions in flight at once, per the plan. */
export const EXTRACTION_CONCURRENCY = 2;

/** The registry, in the order the plan lists the extractors. */
export function defaultExtractors(): Extractor[] {
  return [ffprobeExtractor, pdfinfoExtractor, exifExtractor, epubExtractor, officeExtractor];
}

export interface MetadataRowView {
  itemId: number;
  relPath: string;
  extractor: string;
  extractorVersion: string;
  status: MetadataStatus;
  fields: Record<string, unknown>;
  extractedScan: number;
}

export interface MetadataRunOptions {
  /** Injectable for tests; defaults to the real registry. */
  extractors?: Extractor[];
  /** Injectable for tests; defaults to {@link EXTRACTION_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to {@link EXTRACTION_CONCURRENCY}. */
  concurrency?: number;
  /** Aborts the whole pass; every in-flight extraction is stopped. */
  signal?: AbortSignal;
}

export interface MetadataRunSummary {
  /** Items some extractor applies to. */
  candidates: number;
  /** Extractions actually attempted. */
  extracted: number;
  ok: number;
  failed: number;
  timeouts: number;
  unavailable: number;
  /** Candidates skipped because a current row already existed. */
  unchanged: number;
}

interface CandidateRow {
  id: number;
  rel_path: string;
  kind: string;
  ext: string;
  root_path: string;
}

interface ExistingRow {
  item_id: number;
  extractor: string;
  status: string;
}

/** Statuses that mean "nothing more to do for this item and extractor". */
const SETTLED: ReadonlySet<string> = new Set(['ok', 'failed']);

/**
 * Runs the extractors over a finished scan. Returns the summary; per-item
 * outcomes are written as rows and can be read back with {@link metadataRows}.
 */
export async function extractMetadata(
  store: CatalogueStore,
  scanId: number,
  options: MetadataRunOptions = {},
): Promise<MetadataRunSummary> {
  const extractors = options.extractors ?? defaultExtractors();
  const timeoutMs = options.timeoutMs ?? EXTRACTION_TIMEOUT_MS;
  const concurrency = Math.max(1, options.concurrency ?? EXTRACTION_CONCURRENCY);

  const candidates = store.db
    .prepare(
      `SELECT i.id, i.rel_path, i.kind, i.ext, r.path AS root_path
       FROM items i JOIN roots r ON r.id = i.root_id
       WHERE i.last_seen_scan = ? AND i.status = 'present'
       ORDER BY i.root_id, i.rel_path`,
    )
    .all(scanId) as CandidateRow[];

  const settled = new Map<string, ExistingRow>(
    (store.db
      .prepare(
        `SELECT m.item_id, m.extractor, m.status FROM metadata m
         JOIN items i ON i.id = m.item_id
         WHERE i.last_seen_scan = ?`,
      )
      .all(scanId) as ExistingRow[]).map((row) => [`${row.item_id}:${row.extractor}`, row]),
  );

  const summary: MetadataRunSummary = {
    candidates: 0,
    extracted: 0,
    ok: 0,
    failed: 0,
    timeouts: 0,
    unavailable: 0,
    unchanged: 0,
  };

  // One probe per extractor per scan, shared by every item it covers.
  const availability = new Map<string, Promise<boolean>>();

  const work: { candidate: CandidateRow; extractor: Extractor }[] = [];
  for (const candidate of candidates) {
    for (const extractor of extractors) {
      if (!extractor.appliesTo(candidate.kind as Kind, candidate.ext)) continue;
      summary.candidates += 1;
      const existing = settled.get(`${candidate.id}:${extractor.name}`);
      if (existing !== undefined && SETTLED.has(existing.status)) {
        summary.unchanged += 1;
        continue;
      }
      work.push({ candidate, extractor });
    }
  }

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const job = work[index];
      if (job === undefined) return;

      let usable = availability.get(job.extractor.name);
      if (usable === undefined) {
        usable = job.extractor.available();
        availability.set(job.extractor.name, usable);
      }

      summary.extracted += 1;
      if (!(await usable)) {
        store.upsertMetadata({
          itemId: job.candidate.id,
          extractor: job.extractor.name,
          extractorVersion: job.extractor.version,
          status: 'unavailable',
          fieldsJson: '{}',
          extractedScan: scanId,
        });
        summary.unavailable += 1;
        continue;
      }

      const outcome = await runOne(job, timeoutMs, options.signal);
      store.upsertMetadata({
        itemId: job.candidate.id,
        extractor: job.extractor.name,
        extractorVersion: job.extractor.version,
        status: outcome.status,
        fieldsJson: JSON.stringify(outcome.fields),
        extractedScan: scanId,
      });
      if (outcome.status === 'ok') summary.ok += 1;
      else if (outcome.status === 'failed') summary.failed += 1;
      else if (outcome.status === 'timeout') summary.timeouts += 1;
      else summary.unavailable += 1;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, worker));
  return summary;
}

interface Outcome {
  status: MetadataStatus;
  fields: Record<string, unknown>;
}

/**
 * One extraction under a deadline. The extractor is given a signal and is raced
 * against the same deadline, so a tool that ignores the signal still cannot hold
 * the pass open: the row is recorded as `timeout` either way.
 */
async function runOne(
  job: { candidate: CandidateRow; extractor: Extractor },
  timeoutMs: number,
  outerSignal: AbortSignal | undefined,
): Promise<Outcome> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  outerSignal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const absPath = `${job.candidate.root_path}/${job.candidate.rel_path}`;
  try {
    const extraction = job.extractor
      .extract(absPath, controller.signal)
      .then(
        (fields) => ({ kind: 'fields' as const, fields }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      );
    const deadline = new Promise<{ kind: 'deadline' }>((resolve) => {
      setTimeout(() => resolve({ kind: 'deadline' }), timeoutMs).unref?.();
    });
    const settled = await Promise.race([extraction, deadline]);

    if (settled.kind === 'deadline') return { status: 'timeout', fields: { error: `no result within ${timeoutMs}ms` } };
    if (settled.kind === 'error') {
      // A failure after the deadline is still a timeout, not a parse error.
      if (timedOut) return { status: 'timeout', fields: { error: `no result within ${timeoutMs}ms` } };
      return { status: 'failed', fields: { error: messageOf(settled.error) } };
    }
    return { status: 'ok', fields: settled.fields };
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onAbort);
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

/** Every metadata row, with the item's path, ordered for reports and tests. */
export function metadataRows(store: CatalogueStore, itemId?: number): MetadataRowView[] {
  const filter = itemId === undefined ? '' : ' AND m.item_id = ?';
  const rows = store.db
    .prepare(
      `SELECT m.item_id AS itemId, i.rel_path AS relPath, m.extractor AS extractor,
              m.extractor_version AS extractorVersion, m.status AS status,
              m.fields_json AS fieldsJson, m.extracted_scan AS extractedScan
       FROM metadata m JOIN items i ON i.id = m.item_id
       WHERE 1 = 1${filter}
       ORDER BY i.root_id, i.rel_path, m.extractor`,
    )
    .all(...(itemId === undefined ? [] : [itemId])) as (Omit<MetadataRowView, 'fields'> & {
    fieldsJson: string;
  })[];
  return rows.map((row) => ({ ...row, fields: parseFields(row.fieldsJson) }));
}

function parseFields(fieldsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fieldsJson);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A row this module did not write is still readable as empty.
    return {};
  }
}