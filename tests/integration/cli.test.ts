import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/main.js';

/**
 * CLI verbs call the SAME application service (LLD §7): `apply` requires an
 * approval id and exact action-set hash and can never bypass web approvals
 * or make a provider write directly.
 */

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function world(label: string, files: Record<string, string> = { 'invoice-01.txt': 'first invoice\n', 'invoice-02.txt': 'second invoice\n' }) {
  const dir = mkdtempSync(join('/tmp/opencode', `cli-${label}-`));
  fixtures.push(dir);
  const rootDir = join(dir, 'Downloads');
  mkdirSync(join(rootDir, 'Invoices'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(rootDir, name), content, 'utf8');
  }
  return { dir, rootDir, dbPath: join(dir, 'organiser.sqlite') };
}

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values: unknown[]) => logs.push(values.map(String).join(' '));
  console.error = (...values: unknown[]) => errors.push(values.map(String).join(' '));
  // runCli is async; the exit code is resolved before assertions run.
  return Promise.resolve(
    runCli(args, {
      cwd: process.cwd(),
      env: { ...process.env, FSOPS_BINARY: join(process.cwd(), 'native', 'fsops', 'target', 'release', 'fsops'), ...env },
    }),
  ).then((exitCode) => {
    console.log = originalLog;
    console.error = originalError;
    return { exitCode, stdout: logs.join('\n'), stderr: errors.join('\n') };
  });
}

describe('CLI — same service, no bypass', () => {
  it('doctor reports provider health through the same probe', async () => {
    const result = await run(['doctor']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { providers: { provider: string; status: string }[] };
    expect(parsed.providers.map((entry) => entry.provider)).toEqual(
      expect.arrayContaining(['rules', 'laya', 'clef', 'jev']),
    );
  });

  it('eval:fixture stays deterministic through the CLI path', async () => {
    const result = await run(['eval:fixture']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { synthetic: boolean };
    expect(parsed.synthetic).toBe(true);
  });

  it('scan, classify, review, apply and undo work through one service', async () => {
    const { rootDir, dbPath } = world('flow');
    const env = { ORGANISER_DB: dbPath, ORGANISER_ROOT: rootDir };

    const scan = await run(['scan'], env);
    expect(scan.exitCode).toBe(0);
    const scanned = JSON.parse(scan.stdout) as { candidates: number };
    expect(scanned.candidates).toBe(2);

    // The taxonomy is reviewed before classification (spec review R9): the
    // scan's automatic tree is a starting point, never a routing authority.
    const taxonomy = await run(['taxonomy'], env);
    expect(taxonomy.exitCode).toBe(0);
    const taxonomyReviewed = await run(['taxonomy', '--review'], env);
    expect(taxonomyReviewed.exitCode).toBe(0);

    const classify = await run(['classify'], env);
    expect(classify.exitCode).toBe(0);
    const classified = JSON.parse(classify.stdout) as { proposals: number; deferred: number };
    expect(classified.proposals).toBeGreaterThan(0);

    const review = await run(['review', '--list'], env);
    expect(review.exitCode).toBe(0);
    const reviewed = JSON.parse(review.stdout) as { proposals: { id: string; version: number }[] };
    expect(reviewed.proposals).toHaveLength(classified.proposals);

    const approval = await run(['approve', '--all'], env);
    expect(approval.exitCode).toBe(0);
    const approved = JSON.parse(approval.stdout) as { approvalId: string; actionSetHash: string };
    expect(approved.actionSetHash).toMatch(/^[0-9a-f]{64}$/);

    const wrongHash = await run(['apply', '--approval', approved.approvalId, '--hash', 'a'.repeat(64)], env);
    expect(wrongHash.exitCode).not.toBe(0);
    expect(readFileSync(join(rootDir, 'invoice-01.txt'), 'utf8')).toBe('first invoice\n');

    const applied = await run(['apply', '--approval', approved.approvalId, '--hash', approved.actionSetHash], env);
    expect(applied.exitCode).toBe(0);
    const applyResult = JSON.parse(applied.stdout) as { results: { outcome: string }[] };
    expect(applyResult.results.every((entry) => entry.outcome === 'applied')).toBe(true);
    expect(readFileSync(join(rootDir, 'Invoices', 'invoice-01.txt'), 'utf8')).toBe('first invoice\n');

    const undoApproval = await run(['undo', '--all'], env);
    expect(undoApproval.exitCode).toBe(0);
    const undone = JSON.parse(undoApproval.stdout) as { results: { outcome: string }[] };
    expect(undone.results.every((entry) => entry.outcome === 'undone' || entry.outcome === 'conflict' || entry.outcome === 'applied')).toBe(true);
  });

  it('refuses unknown verbs and refuses to run apply without an approval', async () => {
    const { dbPath, rootDir } = world('refuse');
    const env = { ORGANISER_DB: dbPath, ORGANISER_ROOT: rootDir };
    expect((await run(['frobnicate'], env)).exitCode).not.toBe(0);
    const noApproval = await run(['apply'], env);
    expect(noApproval.exitCode).not.toBe(0);
    expect(readFileSync(join(rootDir, 'invoice-01.txt'), 'utf8')).toBe('first invoice\n');
  });

  it('never falls back to the real Downloads directory when no root is configured', async () => {
    const { dbPath } = world('no-fallback');
    const result = await run(['scan'], { ORGANISER_DB: dbPath });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/OUT_OF_SCOPE|no root configured/i);
  });
});
