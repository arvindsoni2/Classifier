import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Organiser } from '../../src/application/organiser.js';
import { exportLiveBatch, retainBatches } from '../../src/eval/live-export.js';
import { reviewScannedTaxonomy } from '../helpers/review-taxonomy.js';

/**
 * Spec review R12: a scan batch is classified against exactly the items it
 * observed, exclusions are persisted with their reasons, the live batch
 * exports its own decisions/receipts (never the synthetic fixture), and
 * retention never purges a batch with unfinished work.
 */
const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function world(label: string): { rootDir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), `live-${label}-`));
  fixtures.push(dir);
  const rootDir = join(dir, 'Downloads');
  mkdirSync(join(rootDir, 'Invoices'), { recursive: true });
  writeFileSync(join(rootDir, 'invoice-01.txt'), 'first invoice for hosting\n', 'utf8');
  writeFileSync(join(rootDir, 'notes-02.txt'), 'alpha beta gamma\n', 'utf8');
  return { rootDir, dbPath: join(dir, 'organiser.sqlite') };
}

describe('live batch audit, export and retention (R12)', () => {
  it('classifies exactly the items the batch scanned', async () => {
    const { rootDir, dbPath } = world('membership');
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    const scanned = await organiser.scan();
    await reviewScannedTaxonomy(organiser);
    const classified = await organiser.classify(scanned.batchId, 'rules');
    expect(classified.proposals + classified.deferred + classified.failed + (classified.conflicts?.length ?? 0)).toBe(
      scanned.candidates,
    );
    // A second scan observes the same items; its batch classifies only itself.
    const second = await organiser.scan();
    const again = await organiser.classify(second.batchId, 'rules');
    expect(again.proposals + again.deferred + again.failed).toBe(second.candidates);
    organiser.close();
  }, 60_000);

  it('persists exclusions with their reasons', async () => {
    const { rootDir, dbPath } = world('exclusions');
    mkdirSync(join(rootDir, 'A Directory'), { recursive: true });
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    const scanned = await organiser.scan();
    const exclusions = organiser.repositoriesForExport().batches.exclusions(scanned.batchId);
    expect(exclusions.some((reason) => /directory/i.test(reason))).toBe(true);
    organiser.close();
  }, 60_000);

  it('exports the live batch with provenance and no private evidence by default', async () => {
    const { rootDir, dbPath } = world('export');
    const outDir = mkdtempSync(join(tmpdir(), 'live-export-'));
    fixtures.push(outDir);
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    const scanned = await organiser.scan();
    await reviewScannedTaxonomy(organiser);
    await organiser.classify(scanned.batchId, 'rules');

    const exported = exportLiveBatch(organiser.repositoriesForExport(), scanned.batchId, outDir);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.value.decisions).toBeGreaterThan(0);
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) as {
      batchId: string;
      privateEvidenceIncluded: boolean;
    };
    expect(manifest.batchId).toBe(scanned.batchId);
    expect(manifest.privateEvidenceIncluded).toBe(false);
    // Private evidence leaves only on the explicit opt-in.
    expect(existsSync(join(outDir, 'private-evidence.jsonl'))).toBe(false);
    const decisions = readFileSync(join(outDir, 'decisions.jsonl'), 'utf8');
    expect(decisions).toContain('rules@1.0.0');
    expect(decisions).not.toContain('route');
    organiser.close();
  }, 60_000);

  it('refuses to export an unknown batch', () => {
    const { dbPath } = world('unknown');
    const organiser = new Organiser({ dbPath, rootPath: join(tmpdir(), 'unused-root'), stabilityWindowMs: 0 });
    const exported = exportLiveBatch(organiser.repositoriesForExport(), 'batch-missing', join(tmpdir(), 'unused-export'));
    expect(exported.ok).toBe(false);
    organiser.close();
  });

  it('keeps a batch with unfinished work during retention', () => {
    const { rootDir, dbPath } = world('retention');
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    const repositories = organiser.repositoriesForExport();
    repositories.roots.insert({
      id: 'root-1',
      canonicalPath: rootDir,
      device: '65026',
      inode: '900001',
      policyRevision: 1,
    });
    repositories.items.save(
      {
        id: 'item-1',
        sourceId: 'root-1',
        sourceKind: 'filesystem',
        externalId: 'invoice-01.txt',
        displayName: 'invoice-01.txt',
        revision: '1',
        snapshot: {
          device: '65026',
          inode: '900001',
          size: '26',
          mtimeNs: '1760000000000000000',
          ctimeNs: '1760000000000000000',
          sha256: 'd'.repeat(64),
        },
        evidenceId: null,
      },
      'root-1',
    );
    repositories.proposals.save({
      id: 'proposal-1',
      version: 1,
      itemId: 'item-1',
      categoryId: 'cat-invoices',
      destinationId: 'dest-invoices',
      basename: 'invoice-01.txt',
      expected: {
        device: '65026',
        inode: '900001',
        size: '26',
        mtimeNs: '1760000000000000000',
        ctimeNs: '1760000000000000000',
        sha256: 'd'.repeat(64),
      },
      taxonomyRevision: 1,
      policyRevision: 1,
      decisionIds: [],
      state: 'pending',
    });
    const first = repositories.batches.create('root-1');
    repositories.batches.create('root-1');
    // An interrupted action keeps its batch's evidence.
    repositories.approvals.insert({
      id: 'approval-1',
      batchId: first.id,
      actionSetHash: 'c'.repeat(64),
      taxonomyRevision: 1,
      policyRevision: 1,
      selectedActionsJson: '[]',
      expiresAt: '2099-01-01T00:00:00.000Z',
      mode: 'apply',
      pinsJson: null,
    });
    repositories.actions.save({
      id: 'action-pending',
      proposalId: 'proposal-1',
      proposalVersion: 1,
      mode: 'apply',
      approvalId: 'approval-1',
      state: 'intent',
    });

    const retention = retainBatches(repositories, 1);
    expect(retention.kept).toContain(first.id);
    organiser.close();
  });
});
