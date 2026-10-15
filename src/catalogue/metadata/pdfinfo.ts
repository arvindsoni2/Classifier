/**
 * `pdfinfo`: the document information dictionary (plan Task 4).
 *
 * pdfinfo prints `Key: value` lines, so the parser is a line reader rather than
 * a format reader. Only the keys in the plan are kept; anything else the tool
 * reports about a PDF is dropped rather than stored.
 */
import type { Extractor } from './types.js';
import { runTool } from './proc.js';
import { NOT_A_REGULAR_FILE } from '../open.js';
import { lstat } from 'node:fs/promises';

const VERSION = 'pdfinfo@1.0.0';
const TOOL = 'pdfinfo';
const TOOL_TIMEOUT_MS = 10_000;
/** pdfinfo key to catalogue field. Only these are stored. */
const KEYS: Readonly<Record<string, string>> = {
  Title: 'title',
  Author: 'author',
  Subject: 'subject',
  Keywords: 'keywords',
  Creator: 'creator',
  Producer: 'producer',
  CreationDate: 'creationDate',
};

/** Parses `Key: value` lines, ignoring blank lines and continuation noise. */
function parseInfo(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key !== '' && value !== '') fields.set(key, value);
  }
  return fields;
}

function integerOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export const pdfinfoExtractor: Extractor = {
  name: 'pdfinfo',
  version: VERSION,

  appliesTo(kind, ext) {
    // `document` also covers txt, md, rtf and doc, none of which pdfinfo reads.
    return kind === 'document' && ext === 'pdf';
  },

  async available() {
    const probe = await runTool(TOOL, ['-v'], { timeoutMs: TOOL_TIMEOUT_MS });
    return !probe.spawnFailed && probe.code === 0;
  },

  async extract(absPath, signal) {
    // Never spawn a tool for something that is not a regular file: a FIFO or
    // directory swapped in after the scan would otherwise block or mislead.
    const stat = await lstat(absPath).catch(() => null);
    if (stat !== null && !stat.isFile()) {
      const error = new Error(`${NOT_A_REGULAR_FILE}: ${absPath} is not a regular file`) as Error & { code?: string };
      error.code = NOT_A_REGULAR_FILE;
      throw error;
    }

    const run = await runTool(TOOL, [absPath], { timeoutMs: TOOL_TIMEOUT_MS, signal });
    if (run.spawnFailed) throw new Error('pdfinfo is not available on this machine');
    if (run.timedOut) throw new Error(`pdfinfo timed out after ${TOOL_TIMEOUT_MS}ms`);

    const output = run.stdout.toString('utf8');
    const fields = parseInfo(output);
    const encrypted = fields.get('Encrypted');
    const isEncrypted = encrypted !== undefined && encrypted.toLowerCase() === 'yes';

    // A password-protected PDF still reports `Encrypted: yes`, and some builds
    // exit non-zero for it. That is not a catalogue failure: the file is present
    // and its encryption state is known, so record it as ok with what pdfinfo
    // reported. Anything else that exits non-zero is a real failure.
    if (run.code !== 0 && !isEncrypted) {
      throw new Error(`pdfinfo exited ${String(run.code)}: ${run.stderr.trim().slice(0, 200)}`);
    }

    const kept: Record<string, unknown> = {};
    for (const [pdfKey, field] of Object.entries(KEYS)) {
      const value = fields.get(pdfKey);
      if (value !== undefined) kept[field] = value;
    }
    const pages = integerOrUndefined(fields.get('Pages'));
    if (pages !== undefined) kept.pages = pages;
    if (encrypted !== undefined) kept.encrypted = isEncrypted;
    return kept;
  },
};