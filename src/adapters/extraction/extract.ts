/**
 * Bounded format handlers for local document evidence (plan Task 3,
 * PRD §6, LLD §1): strict UTF-8 text, streaming DOCX XML within a 20 MiB
 * uncompressed-byte budget, and a pinned pdftotext worker. Extracted text is
 * capped at 16 KiB / ten PDF pages with visible truncation flags. Downloads
 * contents are untrusted data: nothing extracted here is executed, no
 * relationships or scripts are fetched, and evidence state carries no paths.
 */
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import {
  err,
  ok,
  stableStringify,
  type Evidence,
  type Item,
  type Result,
} from '../../domain/contracts.js';
import { runChild, type ChildRunResult } from './worker.js';

export const EXTRACTOR_REVISION = 'extract@1.0.0';

/** Adapter-owned opened handle; extraction never opens paths itself. */
export interface ReadableInput {
  handle: FileHandle;
  size: number;
}

export interface ExtractionLimits {
  /** Evidence input ceiling per supported document: 20 MiB (PRD §6). */
  maxDocumentInputBytes: number;
  /** Extracted text cap: first 16 KiB of UTF-8 (PRD §6). */
  maxTextBytes: number;
  /** At most ten PDF pages (PRD §6). */
  maxPdfPages: number;
  /** Worker timeout: 10 seconds (PRD §6). */
  timeoutMs: number;
  /** Worker memory limit: 512 MiB (PRD §6). */
  memoryLimitBytes: number;
  /** Pinned helper paths; argument-array spawning only. */
  prlimitPath: string;
  pdftotextPath: string;
}

export function defaultExtractionLimits(): ExtractionLimits {
  return {
    maxDocumentInputBytes: 20 * 1024 * 1024,
    maxTextBytes: 16 * 1024,
    maxPdfPages: 10,
    timeoutMs: 10_000,
    memoryLimitBytes: 512 * 1024 * 1024,
    prlimitPath: '/usr/bin/prlimit',
    pdftotextPath: '/usr/bin/pdftotext',
  };
}

export type ChildRunner = typeof runChild;

export interface ExtractorDeps {
  /** Injectable worker seam for fault injection in tests. */
  runChild?: ChildRunner;
}

type DetectedFormat =
  | 'text'
  | 'markdown'
  | 'pdf'
  | 'docx'
  | 'image'
  | 'archive'
  | 'installer'
  | 'other';

const METADATA_ONLY_FORMATS: ReadonlySet<DetectedFormat> = new Set([
  'image',
  'archive',
  'installer',
  'other',
]);

function detectFormat(basename: string): DetectedFormat {
  const lower = basename.toLowerCase();
  if (lower.endsWith('.txt') || lower.endsWith('.text')) return 'text';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  // Key and certificate material is NOT text evidence: extracting it would
  // put secrets into a provider request. Refused before any format match.
  if (/\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|asc|gpg)$/.test(lower)) return 'other';
  if (/\.(png|jpg|jpeg|gif|webp|bmp|svg|heic|tiff?)$/.test(lower)) return 'image';
  if (/\.(zip|tar|gz|tgz|bz2|xz|7z|rar|zst)$/.test(lower)) return 'archive';
  if (/\.(rpm|deb|exe|msi|appimage|dmg|iso|bin|sh)$/.test(lower)) return 'installer';
  // Source and configuration files are plain text and are read with the same
  // bounded UTF-8 rules as .txt. Without this they fell through to 'other' and
  // a classifier received only a basename for exactly the files a person most
  // wants filed (pilot finding: package.json, rust-pareto.jsx, .html).
  if (/\.(json|jsonc|jsonl|ndjson|jsx|tsx|js|mjs|cjs|ts|html?|xml|csv|tsv|ya?ml|toml|ini|cfg|conf|log|rst|sql|scala|java|kt|kts|go|rs|rb|php|c|h|cc|cpp|hpp|cs|swift|vue|svelte)$/.test(lower))
    return 'text';
  return 'other';
}

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

interface EvidenceOutcome {
  state: Record<string, unknown>;
  status: Evidence['status'];
  truncated: boolean;
}

function buildEvidence(item: Item, outcome: EvidenceOutcome): Evidence {
  const stateHash = sha256(stableStringify(outcome.state));
  return {
    id: `evidence-${sha256(`${item.id}|${stateHash}`).slice(0, 40)}`,
    itemId: item.id,
    profile: outcome.status === 'ready' ? 'compact_text' : 'metadata',
    state: outcome.state,
    stateHash,
    status: outcome.status,
    truncated: outcome.truncated,
    extractorRevision: EXTRACTOR_REVISION,
    inputTokenCounts: {},
  };
}

function baseState(basename: string, format: DetectedFormat, sizeBytes: number): Record<string, unknown> {
  // No paths, no atime: shared evidence is basename, format and size only.
  return { basename, detectedFormat: format, sizeBytes };
}

/** Caps text to the first maxBytes of UTF-8 without cutting a character. */
function capUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  let chars = maxBytes;
  while (chars > 0 && Buffer.byteLength(text.slice(0, chars), 'utf8') > maxBytes) {
    chars -= 1;
  }
  return { text: text.slice(0, chars), truncated: true };
}

async function readAll(input: ReadableInput, limit: number): Promise<Result<Buffer>> {
  if (input.size > limit) {
    return err('OVERSIZE', `input is ${input.size} bytes, above the ${limit}-byte evidence budget`);
  }
  const buffer = Buffer.alloc(input.size);
  const chunk = Buffer.alloc(1024 * 1024);
  let position = 0;
  while (position < input.size) {
    const { bytesRead } = await input.handle.read(chunk, 0, Math.min(chunk.length, input.size - position), position);
    if (bytesRead === 0) break;
    chunk.copy(buffer, position, 0, bytesRead);
    position += bytesRead;
  }
  return ok(buffer.subarray(0, position));
}

function decodeStrictUtf8(buffer: Buffer): Result<string> {
  try {
    return ok(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } catch {
    return err('EXTRACTION_FAILED', 'document is not valid UTF-8; explicit decode failure, not silent replacement');
  }
}

interface TextOutcome {
  status: Evidence['status'];
  note?: string;
  compactText?: string;
  truncated: boolean;
  pages?: number;
}

function textOutcomeToState(outcome: TextOutcome, state: Record<string, unknown>): EvidenceOutcome {
  const next: Record<string, unknown> = { ...state };
  if (outcome.compactText !== undefined) next.compactText = outcome.compactText;
  if (outcome.note !== undefined) next.extractionNote = outcome.note;
  if (outcome.pages !== undefined) next.pages = outcome.pages;
  return { state: next, status: outcome.status, truncated: outcome.truncated };
}

// --- PDF (pinned pdftotext worker) -----------------------------------------

function parsePdfRun(run: ChildRunResult, limits: ExtractionLimits): TextOutcome {
  if (run.timedOut) {
    return { status: 'failed', note: `pdftotext timed out after ${limits.timeoutMs}ms and was killed`, truncated: false };
  }
  if (run.code !== 0) {
    if (/password|encrypt/i.test(run.stderr)) {
      return { status: 'metadata_only', note: 'encrypted (password-protected) PDF; metadata only', truncated: false };
    }
    return {
      status: 'failed',
      note: `pdftotext failed with exit ${run.code ?? 'signal'}: ${run.stderr.trim().slice(0, 200)}`,
      truncated: false,
    };
  }
  const text = run.stdout.toString('utf8');
  if (text.trim().length === 0) {
    return {
      status: 'metadata_only',
      note: 'no text layer (scanned or image-only); remains pending for later OCR',
      truncated: false,
    };
  }
  // Pages are separated by \f. We request maxPdfPages + 1 so a full run
  // proves whether the document has more pages than the budget.
  let pages = text.split('\f');
  // pdftotext writes \f after every page, including the last: drop the empty
  // trailing chunk so an exact budget match is not reported as truncation.
  if (pages.length > 1 && pages[pages.length - 1] === '') pages.pop();
  let truncated = false;
  if (pages.length > limits.maxPdfPages) {
    pages = pages.slice(0, limits.maxPdfPages);
    truncated = true;
  }
  const joined = pages.join('\f');
  const capped = capUtf8(joined, limits.maxTextBytes);
  return {
    status: 'ready',
    compactText: capped.text,
    truncated: truncated || capped.truncated,
    pages: pages.length,
  };
}

// --- DOCX (forward-only ZIP + XML scanning) --------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

interface ZipEntryRecord {
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

function findZipEntry(file: Buffer, wanted: string): Result<ZipEntryRecord> {
  const scanStart = Math.max(0, file.length - 65_557);
  let eocd = -1;
  for (let i = file.length - 22; i >= scanStart; i--) {
    if (file.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    return err('EXTRACTION_FAILED', 'malformed DOCX: end-of-central-directory record not found (truncated or not a ZIP)');
  }
  const entryCount = file.readUInt16LE(eocd + 10);
  let offset = file.readUInt32LE(eocd + 16);
  if (offset + 46 > file.length) {
    return err('EXTRACTION_FAILED', 'malformed DOCX: central directory offset outside the file');
  }
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > file.length || file.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      return err('EXTRACTION_FAILED', 'malformed DOCX: central directory entry truncated');
    }
    const method = file.readUInt16LE(offset + 10);
    const compressedSize = file.readUInt32LE(offset + 20);
    const uncompressedSize = file.readUInt32LE(offset + 24);
    const nameLength = file.readUInt16LE(offset + 28);
    const extraLength = file.readUInt16LE(offset + 30);
    const commentLength = file.readUInt16LE(offset + 32);
    const localOffset = file.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength > file.length) {
      return err('EXTRACTION_FAILED', 'malformed DOCX: central directory name truncated');
    }
    const name = file.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === wanted) {
      return ok({ method, compressedSize, uncompressedSize, localOffset });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return err('EXTRACTION_FAILED', `not a DOCX: ${wanted} entry missing from the archive`);
}

function readZipEntryData(file: Buffer, record: ZipEntryRecord, budget: number): Result<Buffer> {
  if (record.uncompressedSize === 0xffffffff || record.compressedSize === 0xffffffff) {
    return err('EXTRACTION_FAILED', 'unsupported ZIP64 entry');
  }
  if (record.uncompressedSize > budget) {
    return err(
      'EXTRACTION_FAILED',
      `uncompressed entry is ${record.uncompressedSize} bytes, above the ${budget}-byte budget; zip bomb refused`,
    );
  }
  if (record.localOffset + 30 > file.length || file.readUInt32LE(record.localOffset) !== LOCAL_SIGNATURE) {
    return err('EXTRACTION_FAILED', 'malformed DOCX: local header not found at the recorded offset');
  }
  const nameLength = file.readUInt16LE(record.localOffset + 26);
  const extraLength = file.readUInt16LE(record.localOffset + 28);
  const dataStart = record.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + record.compressedSize;
  if (dataEnd > file.length) {
    return err('EXTRACTION_FAILED', 'malformed DOCX: entry data runs past the end of the file');
  }
  const data = file.subarray(dataStart, dataEnd);
  if (record.method === 0) return ok(data);
  if (record.method === 8) {
    try {
      return ok(inflateRawSync(data, { maxOutputLength: budget }));
    } catch {
      return err('EXTRACTION_FAILED', 'malformed DOCX: deflate stream failed to decompress');
    }
  }
  return err('EXTRACTION_FAILED', `unsupported ZIP compression method ${record.method}`);
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Entities must reference real code points: no out-of-range or lone surrogates. */
function invalidCodePoint(codePoint: number): boolean {
  return (
    !Number.isFinite(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  );
}

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    const named = XML_ENTITIES[entity];
    if (named !== undefined) return named;
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      if (invalidCodePoint(codePoint)) {
        throw new RangeError(`invalid XML code point in entity ${match}`);
      }
      return String.fromCodePoint(codePoint);
    }
    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      if (invalidCodePoint(codePoint)) {
        throw new RangeError(`invalid XML code point in entity ${match}`);
      }
      return String.fromCodePoint(codePoint);
    }
    return match;
  });
}

/**
 * Forward-only scanner over word/document.xml: collects <w:t> text, tabs and
 * paragraph breaks without building a tree and without executing anything.
 * Relationships and scripts are never fetched; this scan cannot follow them.
 * Tags are matched on their ELEMENT NAME, so <w:tbl>/<w:tr>/<w:tab> prefix
 * relatives can never be mistaken for <w:t>/<w:tab/> runs.
 */
function scanDocxText(xml: Buffer, budget: number): Result<string> {
  let text = '';
  let position = 0;
  // <w:tab .../> means two different things in WordprocessingML: a tab
  // character inside a run, and a tab-stop definition inside <w:tabs>.
  let inTabs = false;
  const raw = (start: number, end: number) => xml.toString('latin1', start, end);
  const isTag = (start: number, end: number, name: string): boolean => {
    // Matches exactly `<name>`, `<name attr...>` or the closing tag; never `<name...>`.
    const pattern = new RegExp(`^</?${name}(?:\\s[^>]*)?/?>$`, 'i');
    return pattern.test(raw(start, end));
  };
  while (position < xml.length) {
    const open = xml.indexOf('<', position);
    if (open < 0) break;
    const close = xml.indexOf('>', open);
    if (close < 0) break;
    const end = close + 1;
    if (inTabs) {
      // Only the closing tag exits the tab-definition block; everything
      // inside it (including tab-stop definitions) is skipped as data.
      if (raw(open, open + 9) === '</w:tabs>') inTabs = false;
      position = end;
      continue;
    }
    if (isTag(open, end, 'w:tabs')) {
      inTabs = true;
    } else if (isTag(open, end, 'w:p')) {
      if (raw(open, open + 2) === '</') text += '\n';
    } else if (isTag(open, end, 'w:tab')) {
      text += '\t';
    } else if (isTag(open, end, 'w:t')) {
      const textClose = xml.indexOf('</w:t>', end);
      if (textClose < 0) break;
      text += decodeXmlEntities(xml.toString('utf8', end, textClose));
      position = textClose + 6;
      continue;
    }
    position = end;
  }
  if (text.length === 0) {
    return err('EXTRACTION_FAILED', 'DOCX contains no paragraph text in word/document.xml');
  }
  // Each paragraph, including the last, closes with a separator: the final
  // one is an artefact, not content.
  if (text.endsWith('\n')) text = text.slice(0, -1);
  const capped = capUtf8(text, budget);
  return ok(capped.text);
}

// --- Extraction entry point ------------------------------------------------

export interface Extractor {
  extractEvidence(
    item: Item,
    input: ReadableInput,
    limits?: ExtractionLimits,
  ): Promise<Result<Evidence>>;
}

/** Creates an extractor with an injected worker seam and a serial queue. */
export function createExtractor(deps: ExtractorDeps = {}): Extractor {
  const run = deps.runChild ?? runChild;
  // One extraction at a time (PRD §6: Extraction Worker).
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };

  async function extractTextlike(
    item: Item,
    input: ReadableInput,
    limits: ExtractionLimits,
    format: DetectedFormat,
  ): Promise<Result<Evidence>> {
    const state = baseState(item.externalId, format, input.size);
    const read = await readAll(input, limits.maxDocumentInputBytes);
    if (!read.ok) {
      return ok(buildEvidence(item, { state: { ...state, extractionNote: 'oversize input; listed but not extracted' }, status: 'metadata_only', truncated: false }));
    }
    const decoded = decodeStrictUtf8(read.value);
    if (!decoded.ok) {
      return ok(
        buildEvidence(item, textOutcomeToState({ status: 'failed', note: 'invalid UTF-8 (explicit decode failure)', truncated: false }, state)),
      );
    }
    const capped = capUtf8(decoded.value, limits.maxTextBytes);
    return ok(
      buildEvidence(
        item,
        textOutcomeToState({ status: 'ready', compactText: capped.text, truncated: capped.truncated }, state),
      ),
    );
  }

  async function extractPdf(
    item: Item,
    input: ReadableInput,
    limits: ExtractionLimits,
  ): Promise<Result<Evidence>> {
    const state = baseState(item.externalId, 'pdf', input.size);
    if (input.size > limits.maxDocumentInputBytes) {
      return ok(buildEvidence(item, { state: { ...state, extractionNote: 'oversize input; listed but not extracted' }, status: 'metadata_only', truncated: false }));
    }
    const read = await readAll(input, limits.maxDocumentInputBytes);
    if (!read.ok) return read;
    let workerResult: ChildRunResult;
    try {
      workerResult = await run(
        read.value,
        limits.pdftotextPath,
        // -l maxPages+1: one extra page proves whether the budget truncated.
        ['-l', String(limits.maxPdfPages + 1), '-enc', 'UTF-8', '-', '-'],
        { timeoutMs: limits.timeoutMs, memoryLimitBytes: limits.memoryLimitBytes, prlimitPath: limits.prlimitPath },
      );
    } catch (e) {
      return ok(
        buildEvidence(
          item,
          textOutcomeToState(
            { status: 'failed', note: `pdftotext worker unavailable: ${(e as Error).message}`, truncated: false },
            state,
          ),
        ),
      );
    }
    return ok(buildEvidence(item, textOutcomeToState(parsePdfRun(workerResult, limits), state)));
  }

  async function extractDocx(
    item: Item,
    input: ReadableInput,
    limits: ExtractionLimits,
  ): Promise<Result<Evidence>> {
    const state = baseState(item.externalId, 'docx', input.size);
    if (input.size > limits.maxDocumentInputBytes) {
      return ok(buildEvidence(item, { state: { ...state, extractionNote: 'oversize input; listed but not extracted' }, status: 'metadata_only', truncated: false }));
    }
    const read = await readAll(input, limits.maxDocumentInputBytes);
    if (!read.ok) return read;
    const entry = findZipEntry(read.value, 'word/document.xml');
    if (!entry.ok) {
      return ok(
        buildEvidence(item, textOutcomeToState({ status: 'failed', note: entry.detail, truncated: false }, state)),
      );
    }
    const data = readZipEntryData(read.value, entry.value, limits.maxDocumentInputBytes);
    if (!data.ok) {
      return ok(
        buildEvidence(item, textOutcomeToState({ status: 'failed', note: data.detail, truncated: false }, state)),
      );
    }
    let scanned: Result<string>;
    try {
      scanned = scanDocxText(data.value, limits.maxTextBytes);
    } catch (e) {
      scanned = err('EXTRACTION_FAILED', `DOCX entity decoding failed: ${(e as Error).message}`);
    }
    if (!scanned.ok) {
      return ok(
        buildEvidence(item, textOutcomeToState({ status: 'failed', note: scanned.detail, truncated: false }, state)),
      );
    }
    return ok(
      buildEvidence(
        item,
        textOutcomeToState({ status: 'ready', compactText: scanned.value, truncated: Buffer.byteLength(scanned.value, 'utf8') >= limits.maxTextBytes }, state),
      ),
    );
  }

  return {
    async extractEvidence(item, input, limits = defaultExtractionLimits()) {
      return serialize(async () => {
        const format = detectFormat(item.externalId);
        if (METADATA_ONLY_FORMATS.has(format)) {
          return ok(
            buildEvidence(item, {
              state: {
                ...baseState(item.externalId, format, input.size),
                extractionNote: 'unsupported format; metadata only, remains reviewable',
              },
              status: 'metadata_only',
              truncated: false,
            }),
          );
        }
        if (format === 'pdf') return extractPdf(item, input, limits);
        if (format === 'docx') return extractDocx(item, input, limits);
        return extractTextlike(item, input, limits, format);
      });
    },
  };
}

const defaultExtractor = createExtractor();

/** Default extractor with pinned limits (plan Task 3 interface). */
export function extractEvidence(
  item: Item,
  input: ReadableInput,
  limits: ExtractionLimits = defaultExtractionLimits(),
): Promise<Result<Evidence>> {
  return defaultExtractor.extractEvidence(item, input, limits);
}
