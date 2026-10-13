/**
 * Shared extractor contract (plan Task 4).
 *
 * An extractor knows how to read one family of files and nothing else: it
 * decides whether a file is its kind of file, whether it can run at all on this
 * machine, and how to turn a path into a small set of named fields.
 *
 * Extractors never write to the catalogue and never touch anything but the file
 * they are given. Failures are thrown, not returned: the runner records them as
 * a status, because a per-file failure must never stop the pass.
 */
import type { Kind } from '../kinds.js';

export interface Extractor {
  /** Stable identifier stored with every row this extractor writes. */
  name: string;
  /** Version of the extractor itself, so a later change is visible in the data. */
  version: string;
  /** Whether this extractor handles a file of this kind and extension. */
  appliesTo(kind: Kind, ext: string): boolean;
  /** Whether the tool or module this needs is usable here. Checked once a scan. */
  available(): Promise<boolean>;
  /** Reads the file. Throws on failure; must respect `signal`. */
  extract(absPath: string, signal: AbortSignal): Promise<Record<string, unknown>>;
}