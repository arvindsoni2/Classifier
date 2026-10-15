/**
 * Phase 1 Task 5: the catalogue CLI (plan docs/11-Phase-1-Plan.md Task 5).
 *
 * These tests run the built entry point — `node dist/catalogue/cli.js` — rather
 * than importing the CLI in-process, because the plan asks for the end-to-end
 * path a user actually types, including the asset copy that makes `schema.sql`
 * resolvable from `dist`. The build runs in `beforeAll`, so the suite is
 * self-contained rather than depending on someone having run `pnpm build` first.
 *
 * Every root is a synthetic fixture tree (AGENTS.md rule 3). Each test asserts
 * that nothing was written inside it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatProgressLine } from '../../src/catalogue/cli.js';
import { makeFixture, type Fixture } from './fixtures.js';

const REPO_ROOT = process.cwd();
const ENTRY = join(REPO_ROOT, 'dist', 'catalogue', 'cli.js');

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSyncQuiet(dir);
});

function rmSyncQuiet(dir: string): void {
  try {
    execFileSync('rm', ['-rf', dir]);
  } catch {
    // A leftover temp directory is not worth failing a suite over.
  }
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the built CLI as a child process, never through a shell. */
function runCli(args: readonly string[]): CliResult {
  const result = spawnSync(process.execPath, [ENTRY, ...args], { encoding: 'utf8', cwd: REPO_ROOT });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

interface World {
  fixture: Fixture;
  configPath: string;
  dataDir: string;
}

/** A fixture root plus the config the CLI reads, all inside one temp directory. */
function world(label: string): World {
  const fixture = makeFixture(label);
  fixtures.push(fixture.parent);
  const dataDir = join(fixture.parent, 'data');
  const configPath = join(fixture.parent, 'catalogue.json');
  writeFileSync(configPath, JSON.stringify({ roots: [fixture.root], dataDir }), 'utf8');
  return { fixture, configPath, dataDir };
}

function buildWorld(label: string): World {
  const { fixture } = world(label);
  fixture.put('notes/01 one.txt', 'first file\n');
  fixture.put('notes/02 two.txt', 'second file\n');
  fixture.put('notes/03 three.txt', 'third file\n');
  fixture.put('album/01 a.mp3', 'first track bytes\n');
  fixture.put('album/02 b.mp3', 'second track bytes\n');
  fixture.put('album/03 c.mp3', 'third track bytes\n');
  return { fixture, configPath: join(fixture.parent, 'catalogue.json'), dataDir: join(fixture.parent, 'data') };
}

/** Every entry under a directory, so "nothing changed in the root" can be asserted. */
function snapshot(dir: string): Record<string, string> {
  const rows: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        rows[full] = 'dir';
        walk(full);
        continue;
      }
      const stat = statSync(full);
      rows[full] = `${stat.size}:${stat.mtimeMs}`;
    }
  };
  walk(dir);
  return rows;
}

describe('catalogue CLI (Phase 1 Task 5)', () => {
  beforeAll(() => {
    // The plan's build inclusion: tsc for the modules, then the assets
    // (schema.sql) that the compiled store reads next to itself.
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    execFileSync(process.execPath, ['scripts/copy-assets.js'], { cwd: REPO_ROOT, stdio: 'inherit' });
  }, 300_000);

  it('scan, report and stats work end to end from the built entry point', () => {
    const { fixture, configPath, dataDir } = buildWorld('cli-end-to-end');
    const before = snapshot(fixture.root);

    const scan = runCli(['scan', '--config', configPath]);
    expect(scan.stderr).toBe('');
    expect(scan.code).toBe(0);
    expect(scan.stdout).toMatch(/files/i);
    expect(scan.stdout).toMatch(/elapsed/i);
    expect(scan.stdout).toMatch(/\d+ files/);

    const report = runCli(['report', '--config', configPath]);
    expect(report.stderr).toBe('');
    expect(report.code).toBe(0);
    const dirMatch = /(\S*\/reports\/\d+-\d{8}-\d{4})/.exec(report.stdout);
    expect(dirMatch?.[1]).toBeDefined();
    const reportDir = dirMatch?.[1] ?? '';
    expect(reportDir.startsWith(join(dataDir, 'reports'))).toBe(true);
    for (const file of ['summary.md', 'summary.json', 'duplicates.csv', 'bundles.csv', 'errors.csv']) {
      expect(existsSync(join(reportDir, file))).toBe(true);
    }

    const stats = runCli(['stats', '--config', configPath]);
    expect(stats.stderr).toBe('');
    expect(stats.code).toBe(0);
    expect(stats.stdout).toMatch(/files/i);

    // Nothing inside the scanned root was created, changed or removed.
    expect(snapshot(fixture.root)).toEqual(before);
    expect(readdirSync(fixture.root).sort()).toEqual(['album', 'notes']);
  }, 120_000);

  it('--root replaces the configured roots', () => {
    const { fixture, configPath } = buildWorld('cli-root-flag');
    // A second tree that the config does not mention.
    const otherParent = join(fixture.parent, 'other-root');
    mkdirSync(otherParent, { recursive: true });
    writeFileSync(join(otherParent, 'only-here.txt'), 'a file in the other root\n');

    const scan = runCli(['scan', '--config', configPath, '--root', otherParent]);
    expect(scan.code).toBe(0);
    expect(scan.stdout).toContain(otherParent);

    const stats = runCli(['stats', '--config', configPath]);
    // One root from the flag, not two from the config.
    expect(stats.stdout).toMatch(/roots[^\n]*1/i);
  }, 120_000);

  it('report --scan names the scan it wrote', () => {
    const { configPath } = buildWorld('cli-scan-flag');
    expect(runCli(['scan', '--config', configPath]).code).toBe(0);
    const first = runCli(['report', '--config', configPath]);
    expect(first.code).toBe(0);

    // A second scan, then a report for the first by id.
    expect(runCli(['scan', '--config', configPath]).code).toBe(0);
    const summary = JSON.parse(readFileSync(join(firstDir(first.stdout), 'summary.json'), 'utf8')) as {
      scan: { id: number };
    };
    const named = runCli(['report', '--config', configPath, '--scan', String(summary.scan.id)]);
    expect(named.code).toBe(0);
    expect(named.stdout).toContain(String(summary.scan.id));
  }, 120_000);

  it('an invalid --root is refused like an invalid configured root', () => {
  const { fixture, configPath } = buildWorld('cli-bad-root-flag');
  const before = snapshot(fixture.root);

  // A path that is not absolute is refused, and a file where a directory was
  // asked for is refused. A root that does not exist is *not* refused: that is an
  // unplugged drive, and the scan reports it as offline.
  for (const bad of ['relative/path', join(fixture.root, 'notes', '01 one.txt')]) {
    const result = runCli(['scan', '--config', configPath, '--root', bad]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/root/i);
    expect(result.stderr).not.toMatch(/at .*\.js:\d+/);
  }
  const missingRoot = join(fixture.parent, 'no-such-root');
  const unplugged = runCli(['scan', '--config', configPath, '--root', missingRoot]);
  expect(unplugged.code).toBe(0);
  expect(unplugged.stdout).toMatch(/Offline .* 1 root/);
  expect(snapshot(fixture.root)).toEqual(before);
}, 120_000);

it('a missing configuration fails with a message, not a stack trace', () => {
    const missing = join(buildWorld('cli-missing-config').fixture.parent, 'not-here.json');
    for (const verb of ['scan', 'report', 'stats']) {
      const result = runCli([verb, '--config', missing]);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/no catalogue config/i);
      // A configuration failure is a message, not an unhandled rejection.
      expect(result.stderr).not.toMatch(/at .*\.js:\d+/);
    }
  }, 120_000);

  it('an unusable data directory fails without touching the root', () => {
    const { fixture } = buildWorld('cli-bad-datadir');
    const before = snapshot(fixture.root);
    // Point dataDir at a path that cannot be created: a file, not a directory.
    const blocked = join(fixture.parent, 'blocked');
    writeFileSync(blocked, 'not a directory\n');
    const badConfig = join(fixture.parent, 'bad.json');
    writeFileSync(badConfig, JSON.stringify({ roots: [fixture.root], dataDir: blocked }));

    const result = runCli(['scan', '--config', badConfig]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toBe('');
    expect(snapshot(fixture.root)).toEqual(before);
  }, 120_000);

  it('a progress line carries files, bytes and the current root', () => {
    // The 5-second cadence needs a scan that takes 5 seconds to observe, but
    // what the line must say is fixed by the plan and can be checked directly.
    const line = formatProgressLine({ files: 1234, bytes: 5 * 1024 * 1024, root: '/data/Downloads', elapsedMs: 7000 });
    expect(line).toMatch(/1234 files/);
    expect(line).toMatch(/5\.0 MB/);
    expect(line).toContain('/data/Downloads');
    expect(line).toMatch(/7s elapsed/);
  });

  it('--help shows the usage instead of complaining about a command', () => {
  // `--help` is the first thing anyone types, and it arrives before any verb.
  for (const args of [['--help'], ['-h'], ['scan', '--help'], ['--help', 'scan']]) {
    const result = runCli(args);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/catalogue scan/);
    expect(result.stderr).toBe('');
  }
});

it('flags may come before the verb, and only one verb per run', () => {
  const { configPath } = buildWorld('cli-flag-order');
  // --config before the verb is how people type it in practice.
  const scan = runCli(['--config', configPath, 'scan']);
  expect(scan.code).toBe(0);
  expect(scan.stdout).toMatch(/files in/);

  const twoVerbs = runCli(['scan', 'report', '--config', configPath]);
  expect(twoVerbs.code).toBe(2);
  expect(twoVerbs.stderr).toMatch(/only one command/i);

  const dangling = runCli(['scan', '--root']);
  expect(dangling.code).toBe(2);
  expect(dangling.stderr).toMatch(/--root needs a value/i);
}, 120_000);

it('an unknown verb and a bare invocation both explain themselves', () => {
    const noArgs = runCli([]);
    expect(noArgs.code).not.toBe(0);
    expect(noArgs.stdout + noArgs.stderr).toMatch(/scan|report|stats/i);

    const unknown = runCli(['frobnicate']);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toMatch(/unknown command/i);
  }, 120_000);
});

/** The report directory the CLI printed on stdout. */
function firstDir(stdout: string): string {
  const match = /(\S*\/reports\/\d+-\d{8}-\d{4})/.exec(stdout);
  if (match?.[1] === undefined) throw new Error(`no report directory in output: ${stdout}`);
  return match[1];
}