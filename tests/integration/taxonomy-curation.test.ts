import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Organiser } from '../../src/application/organiser.js';
import { reviewScannedTaxonomy, reviewTree } from '../helpers/review-taxonomy.js';

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
  it('surfaces why the automatic suggestion cannot be used instead of swallowing it', async () => {
    // Nine folders cannot map under one group (MAX_CHILDREN_PER_NODE = 7).
    // Follow-up review F2: discovery no longer mutates the semantic tree at
    // all — the overflow is surfaced as an unusable suggestion while the
    // active tree stays seed, and classification remains gated.
    const { rootDir, dbPath } = world('too-many', ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    await organiser.scan();

    const taxonomy = organiser.getTaxonomy();
    expect(taxonomy.ok).toBe(true);
    if (!taxonomy.ok) return;
    // Discovery is physical only: the active tree still holds just the root.
    expect(taxonomy.value.tree.filter((node) => node.parentId === 'root')).toHaveLength(0);
    expect(taxonomy.value.reviewed).toBe(false);
    expect(taxonomy.value.destinations.length).toBeGreaterThanOrEqual(9);
    if (taxonomy.value.status.state !== 'ok') {
      expect(taxonomy.value.status.reason).toMatch(/more than 7/i);
    } else {
      expect.fail('nine folders must leave the suggestion unusable');
    }
    // The suggestion refuses to pretend nine folders fit under one group...
    const suggestion = organiser.suggestTaxonomy();
    expect(suggestion.ok).toBe(false);
    // ...and classification is gated until a curated tree is reviewed.
    await expect(organiser.classify(undefined, 'rules')).rejects.toThrow(/curation required/i);
    organiser.close();
  }, 60_000);

  it('keeps a curated tree stable across refresh, classify, scan and restart (F2)', async () => {
    const { rootDir, dbPath } = world('stable-tree', ['Invoices', 'Media', 'Extra1', 'Extra2', 'Extra3', 'Extra4']);
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    await organiser.scan();
    const taxonomy = organiser.getTaxonomy();
    if (!taxonomy.ok) throw new Error(taxonomy.detail);
    const invoices = taxonomy.value.destinations.find((entry) => entry.segments[0] === 'Invoices');
    expect(invoices).toBeDefined();

    // Curate ONLY the Invoices destination under a custom id, as the pilot does.
    const curated = await organiser.replaceTaxonomy({
      expectedRevision: taxonomy.value.revision,
      tree: [
        { id: 'root', parentId: null, label: 'Inbox', description: 'Root grouping', destinationId: null, kind: 'group' },
        {
          id: 'cat-billing-custom',
          parentId: 'root',
          label: 'Billing',
          description: 'Billing invoice documents',
          destinationId: invoices?.id ?? '',
          kind: 'existing',
        },
      ],
      mappings: [{ categoryId: 'cat-billing-custom', destinationId: invoices?.id ?? '' }],
    });
    expect(curated.ok).toBe(true);
    if (!curated.ok) return;
    const revision = curated.value.revision;

    writeFileSync(join(rootDir, 'invoice-01.txt'), 'first invoice\n', 'utf8');
    const classified = await organiser.classify(undefined, 'rules');
    expect(classified.failed).toBe(0);
    expect(classified.proposals).toBe(1);

    // Refresh paths must not append the other five folders nor bump revision.
    const after = organiser.getTaxonomy();
    if (!after.ok) throw new Error(after.detail);
    expect(after.value.revision).toBe(revision);
    expect(after.value.tree.map((node) => node.id).sort()).toEqual(['cat-billing-custom', 'root']);
    // The other destinations are surfaced separately, never merged.
    expect(after.value.unmapped.length).toBeGreaterThanOrEqual(1);

    await organiser.scan();
    const afterScan = organiser.getTaxonomy();
    if (!afterScan.ok) throw new Error(afterScan.detail);
    expect(afterScan.value.tree.map((node) => node.id).sort()).toEqual(['cat-billing-custom', 'root']);
    expect(afterScan.value.revision).toBe(revision);
    organiser.close();

    const restarted = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    await restarted.scan();
    const afterRestart = restarted.getTaxonomy();
    if (!afterRestart.ok) throw new Error(afterRestart.detail);
    expect(afterRestart.value.tree.map((node) => node.id).sort()).toEqual(['cat-billing-custom', 'root']);
    expect(afterRestart.value.revision).toBe(revision);
    expect(afterRestart.value.reviewed).toBe(true);
    restarted.close();
  }, 60_000);

  it('classifies a reviewed tree even when the auto-suggestion overflows (pilot F2)', async () => {
    // The real pilot root has 500 folders, so the discovery suggestion can
    // NEVER fit under one group. Once the user reviews their own valid tree,
    // the suggestion's overflow must not keep blocking classification.
    const { rootDir, dbPath } = world('reviewed-vs-overflow', [
      'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'Invoices',
    ]);
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    await organiser.scan();

    // Before review: blocked, and the reason is the real overflow.
    await expect(organiser.classify(undefined, 'rules')).rejects.toThrow(/curation required/i);

    const taxonomy = organiser.getTaxonomy();
    if (!taxonomy.ok) throw new Error(taxonomy.detail);
    const invoices = taxonomy.value.destinations.find((entry) => entry.segments[0] === 'Invoices');
    expect(invoices).toBeDefined();
    const reviewed = await organiser.replaceTaxonomy({
      expectedRevision: taxonomy.value.revision,
      tree: [
        { id: 'root', parentId: null, label: 'Inbox', description: 'Root grouping', destinationId: null, kind: 'group' },
        {
          id: 'cat-invoices',
          parentId: 'root',
          label: 'Invoices',
          description: 'Invoice documents',
          destinationId: invoices?.id ?? '',
          kind: 'existing',
        },
      ],
      mappings: [{ categoryId: 'cat-invoices', destinationId: invoices?.id ?? '' }],
    });
    expect(reviewed.ok).toBe(true);

    // After review: status is ok, classification runs, the other nine
    // folders are surfaced as unmapped WITHOUT blocking anything.
    const after = organiser.getTaxonomy();
    if (!after.ok) throw new Error(after.detail);
    expect(after.value.status.state).toBe('ok');
    expect(after.value.unmapped.length).toBeGreaterThanOrEqual(9);
    const classified = await organiser.classify(undefined, 'rules');
    expect(classified.failed).toBe(0);
    organiser.close();
  }, 60_000);

  it('refuses a review whose description the provider contract cannot carry', async () => {
    // The real pilot reviewed a 27-token description and every one of the 72
    // items then failed at request-build time. The review is where that has
    // to be refused, with the offending category named.
    const { rootDir, dbPath } = world('description-budget', ['Invoices', 'Media']);
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    await organiser.scan();
    const taxonomy = organiser.getTaxonomy();
    if (!taxonomy.ok) throw new Error(taxonomy.detail);
    const invoices = taxonomy.value.destinations.find((entry) => entry.segments[0] === 'Invoices');
    expect(invoices).toBeDefined();
    const replaced = await organiser.replaceTaxonomy({
      expectedRevision: taxonomy.value.revision,
      tree: [
        { id: 'root', parentId: null, label: 'Inbox', description: 'Root grouping', destinationId: null, kind: 'group' },
        {
          id: 'cat-invoices',
          parentId: 'root',
          label: 'Invoices',
          description: 'invoice bills receipts statements settlements payments documents and statements',
          destinationId: invoices?.id ?? '',
          kind: 'existing',
        },
      ],
      mappings: [{ categoryId: 'cat-invoices', destinationId: invoices?.id ?? '' }],
    });
    expect(replaced.ok).toBe(false);
    if (replaced.ok) return;
    expect(replaced.detail).toMatch(/cat-invoices/);
    expect(replaced.detail).toMatch(/option-description limit/i);
    organiser.close();
  }, 60_000);

  it('suggests a reviewable description for long folder names', async () => {
    // A 28-byte folder name plus the generated suffix is 66 bytes = 22
    // tokens: without clamping the whole suggestion becomes unreviewable and
    // discovery would strand the root.
    const { rootDir, dbPath } = world('long-folder-names', ['AI_Architect_Handbook_v0.3.0', 'Invoices']);
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    await organiser.scan();

    const suggested = organiser.suggestTaxonomy();
    expect(suggested.ok).toBe(true);
    if (!suggested.ok) return;
    await reviewTree(organiser, suggested.value);

    const after = organiser.getTaxonomy();
    if (!after.ok) throw new Error(after.detail);
    expect(after.value.reviewed).toBe(true);
    expect(after.value.status.state).toBe('ok');
    const classified = await organiser.classify(undefined, 'rules');
    expect(classified.failed).toBe(0);
    expect(classified.conflicts).toHaveLength(0);
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
