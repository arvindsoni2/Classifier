import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createRepositories } from '../../src/adapters/persistence/repositories.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Organiser } from '../../src/application/organiser.js';
import { reviewScannedTaxonomy } from '../helpers/review-taxonomy.js';

/**
 * Spec review F7: a batch's data is exactly ITS OWN. An empty batch must
 * stay empty (never "fall back" to historic root items), proposals and
 * approvals are bound to their batch, and the HTTP apply transport cannot
 * discard the requested batch id.
 */
const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function world(label: string): { rootDir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), `isolation-${label}-`));
  fixtures.push(dir);
  const rootDir = join(dir, 'Downloads');
  mkdirSync(join(rootDir, 'Invoices'), { recursive: true });
  writeFileSync(join(rootDir, 'invoice-01.txt'), 'first invoice\n', 'utf8');
  return { rootDir, dbPath: join(dir, 'organiser.sqlite') };
}

describe('batch isolation (F7)', () => {
  it('an empty second scan classifies nothing historic', async () => {
    const { rootDir, dbPath } = world('empty-batch');
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    await organiser.scan();
    await reviewScannedTaxonomy(organiser);
    const first = await organiser.classify(undefined, 'rules');
    expect(first.proposals).toBe(1);

    // Move the file away: the next scan legitimately has zero candidates.
    rmSync(join(rootDir, 'invoice-01.txt'));
    const second = await organiser.scan();
    expect(second.candidates).toBe(0);
    const classified = await organiser.classify(second.batchId, 'rules');
    expect(classified.proposals).toBe(0);
    expect(classified.failed).toBe(0);
    expect(classified.deferred).toBe(0);
    expect(classified.conflicts ?? []).toHaveLength(0);
    organiser.close();
  }, 60_000);

  it('proposal listing and approval are batch-bound, not root-wide', async () => {
    const { rootDir, dbPath } = world('approval-binding');
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    const first = await organiser.scan();
    await reviewScannedTaxonomy(organiser);
    await organiser.classify(first.batchId, 'rules');
    const listed = await organiser.listProposals(first.batchId);
    expect(listed.ok && listed.value.proposals.length).toBe(1);

    // A fresh batch that observed NOTHING must list and approve nothing.
    rmSync(join(rootDir, 'invoice-01.txt'));
    const second = await organiser.scan();
    expect(second.candidates).toBe(0);
    const emptyList = await organiser.listProposals(second.batchId);
    expect(emptyList.ok && emptyList.value.proposals).toHaveLength(0);
    const proposalId = listed.ok ? (listed.value.proposals[0]?.id ?? '') : '';
    const crossBatch = organiser.service.createApproval(
      second.batchId,
      [{ proposalId, version: 1 }],
      'apply',
      new Date('2026-10-07T10:00:00.000Z'),
    );
    expect(crossBatch.ok).toBe(false);
    if (!crossBatch.ok) expect(crossBatch.code).toBe('OUT_OF_SCOPE');
    organiser.close();
  }, 60_000);

  it('the HTTP apply wrapper refuses a batch/approval mismatch', async () => {
    const { rootDir, dbPath } = world('http-batch');
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    const scanned = await organiser.scan();
    await reviewScannedTaxonomy(organiser);
    await organiser.classify(scanned.batchId, 'rules');
    const approval = await organiser.approveAll(scanned.batchId);
    expect(approval.ok).toBe(true);
    if (!approval.ok) return;

    // An empty later batch must not be able to apply the first batch's work:
    // the transport refuses the mismatch outright (spec review F7).
    rmSync(join(rootDir, 'invoice-01.txt'));
    const other = await organiser.scan();
    const mismatch = await organiser.applyBatch(other.batchId, {
      approvalId: approval.value.approvalId,
      actionSetHash: approval.value.actionSetHash,
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.detail).toMatch(/belongs to batch/);

    // The matching batch id applies normally.
    const matched = await organiser.applyBatch(scanned.batchId, {
      approvalId: approval.value.approvalId,
      actionSetHash: approval.value.actionSetHash,
    });
    expect(matched.ok).toBe(true);
    organiser.close();
  }, 60_000);

  it('reconstructs membership explicitly when an old database is opened (F7)', () => {
    // A pre-F7 database: batches and items exist, the batch_items table does
    // not. Opening it must reconstruct membership once — after which an
    // empty batch is genuinely empty.
    const dir = mkdtempSync(join(tmpdir(), 'isolation-legacy-'));
    fixtures.push(dir);
    const dbPath = join(dir, 'organiser.sqlite');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE roots (id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, device TEXT NOT NULL, inode TEXT NOT NULL, policy_revision INTEGER NOT NULL);
      CREATE TABLE batches (id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES roots(id), stage TEXT NOT NULL, created_at TEXT NOT NULL, cancellation_requested INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE items (id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES roots(id), external_id TEXT NOT NULL, revision TEXT NOT NULL, snapshot_json TEXT, UNIQUE(root_id, external_id, revision));
      INSERT INTO roots VALUES ('root-old', '/synthetic', '65026', '900001', 1);
      INSERT INTO batches VALUES ('batch-old', 'root-old', 'review', '2026-10-01T00:00:00.000Z', 0);
      INSERT INTO items VALUES ('item-old', 'root-old', 'invoice-01.txt', '1', '{}');
    `);
    raw.close();

    const repos = createRepositories(dbPath);
    expect(repos.items.hasMembership()).toBe(true);
    expect(repos.items.listByBatch('batch-old').map((row) => row.item.id)).toEqual(['item-old']);
    repos.close();
  });
});