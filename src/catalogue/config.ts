/**
 * Catalogue configuration: `config/local/catalogue.json`, gitignored, with
 * `CLASSIFIER_CONFIG` overriding the path.
 *
 * Validation is deliberately strict. An invalid configuration is an error with
 * a message that says what to fix, never a silent fallback to a default root
 * (plan Task 1; spec §7.2 — the data directory never sits inside a root).
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

/** Directories that are noise in every root and are never entered. */
export const DEFAULT_EXCLUDE: readonly string[] = [
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.cache',
  '.Trash-*',
];

export interface CatalogueConfig {
  /** Absolute, existing directories to catalogue. Never nested in one another. */
  roots: string[];
  /** Directory names (or `*` globs) that are not entered. */
  exclude: string[];
  /** Absolute path of the data directory; always outside every root. */
  dataDir: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Expands a leading `~` so `~/.local/share/classifier` works in config files. */
function expandHome(path: string): string {
  return path === '~' || path.startsWith(`~${sep}`) ? join(homedir(), path.slice(1)) : path;
}

/** True when `child` is `parent` itself or sits below it. */
export function contains(parent: string, child: string): boolean {
  if (parent === child) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/** Name pattern match: an exact name, or a glob with a single trailing `*`. */
export function matchesExclude(name: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === name) return true;
    if (pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ConfigError(`config field "${field}" must be an array of strings`);
  }
  return [...(value as string[])];
}

/** Validates already-parsed configuration; exported for tests and tooling. */
export function validateConfig(raw: unknown): CatalogueConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('config must be a JSON object');
  }
  const record = raw as Record<string, unknown>;

  const rawRoots = requireStringArray(record.roots, 'roots');
  if (rawRoots.length === 0) throw new ConfigError('config field "roots" must list at least one directory');

  const roots: string[] = [];
  for (const entry of rawRoots) {
    const expanded = expandHome(entry);
    if (!isAbsolute(expanded)) {
      throw new ConfigError(`root ${JSON.stringify(entry)} must be an absolute path`);
    }
    if (!existsSync(expanded)) {
      throw new ConfigError(`root ${JSON.stringify(entry)} does not exist (resolved to ${expanded})`);
    }
    if (!statSync(expanded).isDirectory()) {
      throw new ConfigError(`root ${JSON.stringify(entry)} is not a directory`);
    }
    // Realpath so a symlinked root is compared against what it really is.
    roots.push(realpathSync(expanded));
  }

  const dataDirRaw = record.dataDir;
  if (typeof dataDirRaw !== 'string' || dataDirRaw.length === 0) {
    throw new ConfigError('config field "dataDir" must be a non-empty path');
  }
  const dataDir = resolve(expandHome(dataDirRaw));
  if (!isAbsolute(dataDir)) {
    throw new ConfigError(`dataDir ${JSON.stringify(dataDirRaw)} must resolve to an absolute path`);
  }

  for (const outer of roots) {
    for (const inner of roots) {
      if (outer === inner) continue;
      if (contains(outer, inner)) {
        throw new ConfigError(
          `root ${inner} is inside another root (${outer}); configure one root per directory tree`,
        );
      }
    }
    if (contains(outer, dataDir)) {
      throw new ConfigError(
        `dataDir ${dataDir} is inside root ${outer}; the catalogue must never be written inside a scanned root`,
      );
    }
  }

  const exclude =
    record.exclude === undefined ? [...DEFAULT_EXCLUDE] : requireStringArray(record.exclude, 'exclude');

  return { roots, exclude, dataDir };
}

/**
 * Reads and validates the catalogue configuration.
 *
 * @param path configuration file; defaults to `CLASSIFIER_CONFIG`, then
 * `config/local/catalogue.json` under the working directory.
 */
export function loadConfig(path?: string): CatalogueConfig {
  const resolved =
    path ?? process.env.CLASSIFIER_CONFIG ?? resolve(process.cwd(), 'config', 'local', 'catalogue.json');
  if (!existsSync(resolved)) {
    throw new ConfigError(
      `no catalogue config at ${resolved}; create it from config/catalogue.example.json or set CLASSIFIER_CONFIG`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new ConfigError(`config ${resolved} is not valid JSON: ${(error as Error).message}`);
  }
  return validateConfig(parsed);
}