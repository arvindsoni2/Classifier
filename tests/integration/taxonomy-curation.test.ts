import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Organiser } from '../../src/application/organiser.js';
import { reviewScannedTaxonomy } from '../helpers/review-taxonomy.js';

/**
 * Spec review R9: discovered folders stay separate from the approved semantic
 * tree, an automatic tree that cannot be valid is surfaced rather than
 * silently ignored, classification requires a reviewed taxonomy, and the
 * reviewed revision survives a restart.
 */
const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function world(label: string, folders: string[]): { rootDir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), `taxonomy-${label}-`));
  fixtures.push(dir);
  const rootDir = join(dir, 'Downloads');
  mkdirSync(rootDir, { recursive: true });
  for (const folder of folders) mkdirSync(join(rootDir, folder), { recursive: true });
  writeFileSync(join(rootDir, 'invoice-01.txt'), 'first invoice\n', 'utf8');
  return { rootDir, dbPath: join(dir, 'organiser.sqlite') };
}

describe('taxonomy curation (R9)', () => {
  it('surfaces why the automatic tree was refused instead of ignoring it', async () => {
    // Nine folders cannot map under one group (MAX_CHILDREN_PER_NODE = 7).
    const { rootDir, dbPath } = world('too-many', ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    await organiser.scan();

    const taxonomy = organiser.getTaxonomy();
    expect(taxonomy.ok).toBe(true);
    if (!taxonomy.ok) return;
    // The refusal is visible, with the reason and the discovered catalogue.
    expect(taxonomy.value.status.state).toBe('curation_required');
    if (taxonomy.value.status.state === 'curation_required') {
      expect(taxonomy.value.status.reason).toMatch(/more than 7 children/i);
    }
    expect(taxonomy.value.reviewed).toBe(false);
    expect(taxonomy.value.destinations.length).toBeGreaterThanOrEqual(9);
    organiser.close();
  }, 60_000);

  it('refuses classification until the taxonomy is reviewed', async () => {
    const { rootDir, dbPath } = world('gate', ['Invoices']);
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    await organiser.scan();

    await expect(organiser.classify(undefined, 'rules')).rejects.toThrow(/not been reviewed/i);

    await reviewScannedTaxonomy(organiser);
    const classified = await organiser.classify(undefined, 'rules');
    expect(classified.failed).toBe(0);
    expect(classified.proposals).toBe(1);
    organiser.close();
  }, 60_000);

  it('keeps the reviewed revision across a restart', async () => {
    const { rootDir, dbPath } = world('restart', ['Invoices']);
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    await organiser.scan();
    const reviewed = await reviewScannedTaxonomy(organiser);
    expect(reviewed).toBeGreaterThan(1);
    organiser.close();

    const restarted = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    const taxonomy = restarted.getTaxonomy();
    expect(taxonomy.ok).toBe(true);
    if (!taxonomy.ok) return;
    expect(taxonomy.value.revision).toBe(reviewed);
    expect(taxonomy.value.reviewed).toBe(true);
    expect(taxonomy.value.status.state).toBe('ok');
    // And the reviewed tree can classify on the restarted process.
    const classified = await restarted.classify(undefined, 'rules');
    expect(classified.proposals).toBe(1);
    restarted.close();
  }, 60_000);

  it('curation replaces the automatic tree and maps destinations explicitly', async () => {
    const { rootDir, dbPath } = world('curate', ['Invoices', 'Media']);
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    await organiser.scan();
    const taxonomy = organiser.getTaxonomy();
    if (!taxonomy.ok) throw new Error(taxonomy.detail);
    const invoices = taxonomy.value.destinations.find((destination) => destination.segments[0] === 'Invoices');
    expect(invoices).toBeDefined();

    // The user curates: one group, one mapped category.
    const replaced = await organiser.replaceTaxonomy({
      expectedRevision: taxonomy.value.revision,
      tree: [
        { id: 'root', parentId: null, label: 'Inbox', description: 'Root grouping', destinationId: null, kind: 'group' },
        {
          id: 'cat-billing',
          parentId: 'root',
          label: 'Billing',
          description: 'Billing invoice documents',
          destinationId: invoices?.id ?? '',
          kind: 'existing',
        },
      ],
      mappings: [{ categoryId: 'cat-billing', destinationId: invoices?.id ?? '' }],
    });
    expect(replaced.ok).toBe(true);

    const classified = await organiser.classify(undefined, 'rules');
    expect(classified.proposals).toBe(1);
    const proposals = await organiser.listProposals();
    expect(proposals.ok && proposals.value.proposals[0]?.destinationId).toBe(invoices?.id);
    organiser.close();
  }, 60_000);
});
