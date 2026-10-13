/**
 * `pnpm catalogue` — the Phase 1 command line (plan Task 5).
 *
 *   catalogue scan   [--root <abs path> ...] [--config <path>]
 *   catalogue report [--scan <id>] [--config <path>]
 *   catalogue stats  [--scan <id>] [--config <path>]
 *
 * Three rules shape it:
 *
 *  - **Read-only on the roots.** Every verb reads a root or writes into the data
 *    directory. Nothing here creates, moves or deletes anything a scan can see
 *    (AGENTS.md rule 4).
 *  - **Per-file problems are counts, not exit codes.** A file that cannot be
 *    read is a line in `errors.csv`, and the command still succeeds. Only a
 *    configuration or database failure is fatal, because then there is no
 *    trustworthy answer to give.
 *  - **The scan runs the whole pipeline.** `scan` is not just the walk: it also
 *    hashes, detects bundles and extracts metadata, so the numbers it prints are
 *    the ones the report will contain.
 */
import { bundleScanHook, detectBundles } from './bundles.js';
import { loadConfig, validateConfig, ConfigError, type CatalogueConfig } from './config.js';
import { computeHashes } from './dedupe.js';
import { extractMetadata } from './metadata/index.js';
import { latestFinishedScan, reportSummary, writeReport } from './report.js';
import { scan } from './scanner.js';
import { openStore } from './store.js';

/** How often a running scan prints progress, per the plan. */
export const PROGRESS_INTERVAL_MS = 5_000;

const USAGE = `catalogue — read-only catalogue of your directories

  catalogue scan   [--root <abs path> ...] [--config <path>]
  catalogue report [--scan <id>] [--config <path>]
  catalogue stats  [--scan <id>] [--config <path>]

--root replaces the configured roots; without it the config's roots are used.
--config defaults to $CLASSIFIER_CONFIG, then config/local/catalogue.json.`;

interface ParsedArgs {
  verb: string;
  roots: string[];
  scanId: number | undefined;
  configPath: string | undefined;
}

/** Thrown for a bad command line, as opposed to a bad configuration. */
class UsageError extends Error {}

/** Parses argv without a library: flags the plan names, and nothing else. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { verb: argv[0] ?? '', roots: [], scanId: undefined, configPath: undefined };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) throw new UsageError(`${arg} needs a value`);
      index += 1;
      return next;
    };
    switch (arg) {
      case '--root':
        parsed.roots.push(value());
        break;
      case '--scan': {
        const raw = value();
        if (!/^\d+$/.test(raw)) throw new UsageError(`--scan needs a scan id, not ${JSON.stringify(raw)}`);
        parsed.scanId = Number.parseInt(raw, 10);
        break;
      }
      case '--config':
        parsed.configPath = value();
        break;
      case '--help':
      case '-h':
        parsed.verb = 'help';
        break;
      default:
        throw new UsageError(`unknown option ${JSON.stringify(arg)}`);
    }
  }
  return parsed;
}

/** One progress line: how far the walk has got, and where it is. */
export function formatProgressLine(progress: {
  files: number;
  bytes: number;
  root: string;
  elapsedMs: number;
}): string {
  const megabytes = (progress.bytes / (1024 * 1024)).toFixed(1);
  const seconds = (progress.elapsedMs / 1000).toFixed(0);
  return `scanning ${progress.root}: ${progress.files} files, ${megabytes} MB, ${seconds}s elapsed`;
}

/**
 * Runs one command and returns the process exit code: 0 on success, 1 for a
 * configuration or database failure, 2 for a bad command line.
 */
export async function runCatalogueCli(argv: readonly string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      console.error(USAGE);
      return 2;
    }
    throw error;
  }

  if (args.verb === 'help' || args.verb === '') {
    console.log(USAGE);
    return args.verb === '' ? 2 : 0;
  }
  if (args.verb !== 'scan' && args.verb !== 'report' && args.verb !== 'stats') {
    console.error(`unknown command ${JSON.stringify(args.verb)}`);
    console.error(USAGE);
    return 2;
  }

  let config: CatalogueConfig;
  try {
    config = loadConfig(args.configPath);
    if (args.roots.length > 0) {
      // Re-validated rather than trusted: --root goes through the same checks
      // as a configured root, including the dataDir-outside-root rule.
      config = validateConfig({ roots: args.roots, dataDir: config.dataDir, exclude: config.exclude });
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  try {
    if (args.verb === 'scan') return await runScan(config);
    return runReadOnly(config, args.verb, args.scanId);
  } catch (error) {
    // A database failure is the other fatal case: there is no catalogue to
    // report on. Anything else is a bug and keeps its stack.
    console.error(`catalogue ${args.verb} failed: ${(error as Error).message}`);
    return 1;
  }
}

async function runScan(config: CatalogueConfig): Promise<number> {
  const store = openStore(config.dataDir);
  try {
    const progress = setInterval(() => {
      console.log(formatProgressLine(readProgress(store)));
    }, PROGRESS_INTERVAL_MS);
    // Never hold the process open just to print progress.
    progress.unref?.();

    const startedAt = Date.now();
    const result = await scan(config, store, { onDirectory: bundleScanHook(store) });
    const hashes = await computeHashes(store, result.scanId);
    const bundles = detectBundles(store, result.scanId);
    const metadata = await extractMetadata(store, result.scanId);
    clearInterval(progress);

    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      [
        `Scan ${result.scanId} of ${result.roots} root(s) finished.`,
        `Roots: ${config.roots.join(', ')}`,
        `${result.totals.filesSeen} files in ${result.totals.dirsSeen} directories, ` +
          `${formatBytes(result.totals.bytesSeen)}, ${result.totals.errors} errors.`,
        `Hashed ${hashes.filesHashed} file(s); ${bundles.length} bundle(s); ` +
          `metadata ok for ${metadata.ok} of ${metadata.candidates}.`,
        `Elapsed: ${elapsedSeconds}s`,
        `Catalogue: ${store.path}`,
      ].join('\n'),
    );
    return 0;
  } finally {
    store.close();
  }
}

function runReadOnly(config: CatalogueConfig, verb: 'report' | 'stats', scanId: number | undefined): number {
  const store = openStore(config.dataDir);
  try {
    const target = scanId ?? latestFinishedScan(store);
    if (target === undefined) {
      console.error('no finished scan in the catalogue; run `catalogue scan` first');
      return 1;
    }

    if (verb === 'report') {
      const report = writeReport(store, target, config.dataDir);
      console.log(`Report for scan ${target}: ${report.dir}`);
      console.log(report.files.join(', '));
      return 0;
    }

    // `stats` prints the same figures a report would hold, and writes nothing.
    const summary = reportSummary(store, target);
    console.log(formatStats(summary));
    return 0;
  } finally {
    store.close();
  }
}

function formatStats(summary: ReturnType<typeof reportSummary>): string {
  const scan = summary.scan;
  return [
    `Scan ${scan.id} (${scan.status}) — ${scan.filesSeen} files, ` +
      `${formatBytes(scan.bytesSeen)}, ${scan.errors} errors, ${(scan.durationMs / 1000).toFixed(1)}s.`,
    `Roots: ${summary.roots.length}`,
    ...summary.roots.map((root) => `  ${root.path}: ${root.files} files, ${formatBytes(root.bytes)}`),
    ...summary.kinds.map((kind) => `  ${kind.kind}: ${kind.files} files, ${formatBytes(kind.bytes)}`),
    `  ${summary.bundles.total} bundles, ${summary.duplicates.groups} duplicate groups, ` +
      `${formatBytes(summary.duplicates.wastedBytes)} wasted.`,
  ].join('\n');
}

/** Counts the running scan has reached, read from the catalogue. */
function readProgress(store: ReturnType<typeof openStore>): {
  files: number;
  bytes: number;
  root: string;
  elapsedMs: number;
} {
  const running = store.db
    .prepare("SELECT id, started_at FROM scans WHERE status = 'running' ORDER BY id DESC LIMIT 1")
    .get() as { id: number; started_at: string } | undefined;
  if (running === undefined) return { files: 0, bytes: 0, root: '(no scan running)', elapsedMs: 0 };

  const totals = store.db
    .prepare(
      `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM items
       WHERE last_seen_scan = ? AND status <> 'missing'`,
    )
    .get(running.id) as { files: number; bytes: number };
  const current = store.db
    .prepare(
      `SELECT r.path AS root FROM dirs d JOIN roots r ON r.id = d.root_id
       WHERE d.last_seen_scan = ? ORDER BY d.id DESC LIMIT 1`,
    )
    .get(running.id) as { root: string } | undefined;

  return {
    files: totals.files,
    bytes: totals.bytes,
    root: current?.root ?? '(starting)',
    elapsedMs: Math.max(0, Date.now() - Date.parse(running.started_at)),
  };
}

function formatBytes(value: number): string {
  return `${value.toLocaleString('en-US')} bytes`;
}

// Run when executed as a program; imported as a library, this does nothing.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runCatalogueCli(process.argv.slice(2));
}