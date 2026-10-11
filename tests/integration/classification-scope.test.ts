import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Organiser } from '../../src/application/organiser.js';
import { reviewScannedTaxonomy } from '../helpers/review-taxonomy.js';

/**
 * Spec review R3: classification must obtain read handles through anchored,
 * no-symlink resolution and verify the opened file against the scanned
 * snapshot. A file replaced by a symlink after the scan must defer as a
 * visible conflict — private content outside the root is never extracted.
 */
const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

const PRIVATE_OUTSIDE = 'PRIVATE OUTSIDE ROOT CONTENT invoice hosting bill';

function world(label: string): { rootDir: string; outsideDir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), `scope-${label}-`));
  fixtures.push(dir);
  const rootDir = join(dir, 'Downloads');
  const outsideDir = join(dir, 'Private');
  mkdirSync(rootDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, 'secret.txt'), `${PRIVATE_OUTSIDE}\n`, 'utf8');
  return { rootDir, outsideDir, dbPath: join(dir, 'organiser.sqlite') };
}

describe('classification scope (R3)', () => {
  it('refuses a symlink swapped in after the scan', async () => {
    const { rootDir, outsideDir, dbPath } = world('symlink');
    writeFileSync(join(rootDir, 'invoice-01.txt'), 'invoice for hosting services\n', 'utf8');
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    const scanned = await organiser.scan();
    expect(scanned.candidates).toBe(1);
    expect(scanned.rootId).toMatch(/^root-/);

    // The attack: replace the scanned regular file with a symlink out of the root.
    rmSync(join(rootDir, 'invoice-01.txt'));
    symlinkSync(join(outsideDir, 'secret.txt'), join(rootDir, 'invoice-01.txt'));

    await reviewScannedTaxonomy(organiser);
    const result = await organiser.classify(undefined, 'rules');
    expect(result.proposals).toBe(0);
    expect(result.conflicts?.map((entry) => entry.basename)).toContain('invoice-01.txt');
    expect(result.conflicts?.some((entry) => /symlink/i.test(entry.reason))).toBe(true);
    // The private content never became evidence or a decision.
    const proposals = await organiser.listProposals();
    expect(proposals.ok && proposals.value).toHaveLength(0);
    organiser.close();
  }, 60_000);

  it('defers an item whose bytes changed after the scan', async () => {
    const { rootDir, dbPath } = world('changed');
    writeFileSync(join(rootDir, 'invoice-02.txt'), 'invoice for hosting services\n', 'utf8');
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    const scanned = await organiser.scan();
    expect(scanned.candidates).toBe(1);

    // Same name, same type, different content: the snapshot no longer matches.
    rmSync(join(rootDir, 'invoice-02.txt'));
    writeFileSync(join(rootDir, 'invoice-02.txt'), 'totally different content now\n', 'utf8');

    await reviewScannedTaxonomy(organiser);
    const result = await organiser.classify(undefined, 'rules');
    expect(result.proposals).toBe(0);
    expect(result.conflicts?.map((entry) => entry.basename)).toContain('invoice-02.txt');
    const proposals = await organiser.listProposals();
    expect(proposals.ok && proposals.value).toHaveLength(0);
    organiser.close();
  }, 60_000);

  it('classifies an unchanged item', async () => {
    const { rootDir, dbPath } = world('unchanged');
    mkdirSync(join(rootDir, 'Documents'), { recursive: true });
    writeFileSync(join(rootDir, 'invoice-03.txt'), 'invoice for hosting services\n', 'utf8');
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    await organiser.scan();
    await reviewScannedTaxonomy(organiser);
    const result = await organiser.classify(undefined, 'rules');
    // The item passes the scope and snapshot gates and reaches the provider:
    // the rules baseline then defers it on the auto-generated category
    // description (visible deferral), which is not a scope conflict.
    expect(result.conflicts ?? []).toHaveLength(0);
    expect(result.failed).toBe(0);
    expect(result.deferredItems).toContain('invoice-03.txt');
    organiser.close();
  }, 60_000);
});
