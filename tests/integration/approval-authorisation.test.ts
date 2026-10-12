import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Category, Id, Item, Proposal, Revision } from '../../src/domain/contracts.js';
import { createRepositories } from '../../src/adapters/persistence/repositories.js';
import { planPlacement } from '../../src/domain/planner.js';
import { Organiser } from '../../src/application/organiser.js';
import { makeWorld, snapshotOf, type World } from '../helpers/workflow-world.js';

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function tempWorld(label: string): { dir: string; dbPath: string; rootDir: string } {
  const dir = mkdtempSync(join(tmpdir(), `authorisation-${label}-`));
  fixtures.push(dir);
  const rootDir = join(dir, 'Downloads');
  mkdirSync(join(rootDir, 'Documents'), { recursive: true });
  return { dir, dbPath: join(dir, 'organiser.sqlite'), rootDir };
}

function seedProposal(
  repositories: ReturnType<typeof createRepositories>,
  rootId: Id,
  basename: string,
  content: string,
  destinationId: string,
  taxonomyRevision: Revision,
): Proposal {
  const item: Item = {
    id: `item-${basename}`,
    sourceId: rootId,
    sourceKind: 'filesystem',
    externalId: basename,
    displayName: basename,
    revision: '1',
    snapshot: snapshotOf(basename, content),
    evidenceId: 'evidence-1',
  };
  repositories.items.save(item, rootId);
  const planned = planPlacement(
    item,
    { answers: [{ nodeId: 'root', questionId: 'q-root', selectedId: 'cat-invoices' }] },
    {
      revision: taxonomyRevision,
      tree: [
        { id: 'root', parentId: null, label: 'Inbox', description: 'Root grouping', destinationId: null, kind: 'group' },
        { id: 'cat-invoices', parentId: 'root', label: 'Invoices', description: 'Invoice documents', destinationId, kind: 'existing' },
      ],
      mappingHash: 'seed',
    },
    1,
  );
  if (!planned.ok) throw new Error(planned.detail);
  const proposal: Proposal = { ...planned.value, id: `proposal-${basename}` };
  repositories.proposals.save(proposal);
  return proposal;
}

describe('approval authorisation (R1)', () => {
  it('refuses an approval created with undo mode when applying', async () => {
    const world: World = makeWorld('wrong-mode-apply');
    const before = world.read('invoice-01.txt');
    const undoApproval = world.service.createApproval(
      world.batch.id,
      world.proposals.map((proposal) => ({ proposalId: proposal.id, version: proposal.version })),
      'undo',
      new Date('2026-10-07T10:00:00.000Z'),
    );
    expect(undoApproval.ok).toBe(true);
    if (!undoApproval.ok) return;

    const result = await world.service.applyBatch(
      world.batch.id,
      undoApproval.value.id,
      undoApproval.value.actionSetHash,
    );
    expect(result.results.every((action) => action.outcome === 'stale')).toBe(true);
    expect(world.helper.calls).toHaveLength(0);
    expect(world.read('invoice-01.txt')).toBe(before);
    expect(world.exists('Documents/invoice-01.txt')).toBe(false);
  });

  it('refuses an apply-mode approval presented for undo', async () => {
    const world: World = makeWorld('wrong-mode-undo');
    const approval = world.approve();
    await world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash);
    expect(world.exists('Documents/invoice-01.txt')).toBe(true);

    const action = world.repositories.actions.find('proposal-invoice-01.txt', 1, 'apply');
    expect(action).not.toBeNull();

    const undone = await world.service.undoAction(action?.id ?? '', approval.approvalId);
    expect(undone.ok).toBe(false);
    if (!undone.ok) expect(undone.code).toBe('UNAUTHORISED');
    expect(world.helper.calls.filter((call) => call.verb === 'undo')).toHaveLength(0);
    expect(world.exists('Documents/invoice-01.txt')).toBe(true);
  });

  it('refuses an approval bound to a different batch', async () => {
    const world: World = makeWorld('foreign-batch');
    const otherBatch = world.repositories.batches.create('root-1');
    const approval = world.approve();
    const result = await world.service.applyBatch(otherBatch.id, approval.approvalId, approval.actionSetHash);
    expect(result.results.every((action) => action.outcome === 'stale')).toBe(true);
    expect(world.helper.calls).toHaveLength(0);
    expect(world.exists('Documents/invoice-01.txt')).toBe(false);
  });

  it('stales outstanding approvals when the taxonomy is replaced', async () => {
    const { dbPath, rootDir } = tempWorld('taxonomy-replace');
    writeFileSync(join(rootDir, 'invoice-01.txt'), 'first invoice\n', 'utf8');
    const repositories = createRepositories(dbPath);
    // scan() upserts the root row itself.
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    const scanned = await organiser.scan();

    const taxonomy = organiser.getTaxonomy();
    expect(taxonomy.ok).toBe(true);
    if (!taxonomy.ok) return;
    // F2: discovery no longer populates the active tree; take the real
    // destination identity from the physical catalogue instead.
    const discovered = taxonomy.value.destinations.find((destination) => destination.segments[0] === 'Documents');
    expect(discovered).toBeDefined();
    const destinationId = discovered?.id ?? '';
    const proposal = seedProposal(repositories, scanned.rootId, 'invoice-01.txt', 'first invoice\n', destinationId, taxonomy.value.revision);
    const batchId = repositories.batches.listByRoot(scanned.rootId)[0]?.id ?? '';
    const approved = organiser.service.createApproval(
      batchId,
      [{ proposalId: proposal.id, version: proposal.version }],
      'apply',
      new Date('2026-10-07T10:00:00.000Z'),
    );
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;

    // The user re-curates the taxonomy: revision moves from 1 to 2.
    const tree: Category[] = [
      { id: 'root', parentId: null, label: 'Inbox', description: 'Root grouping', destinationId: null, kind: 'group' },
      {
        id: 'cat-invoices',
        parentId: 'root',
        label: 'Invoices and billing',
        description: 'Invoice documents',
        destinationId,
        kind: 'existing',
      },
    ];
    const replaced = await organiser.replaceTaxonomy({
      expectedRevision: taxonomy.value.revision,
      tree,
      mappings: [{ categoryId: 'cat-invoices', destinationId }],
    });
    expect(replaced.ok).toBe(true);

    // The old approval must no longer authorise anything.
    const result = await organiser.service.applyBatch(batchId, approved.value.id, approved.value.actionSetHash);
    expect(result.results.every((action) => action.outcome === 'stale')).toBe(true);
    // And no fresh approval may bind the stale revision either.
    const reapproved = organiser.service.createApproval(
      batchId,
      [{ proposalId: proposal.id, version: proposal.version }],
      'apply',
      new Date('2026-10-07T10:00:00.000Z'),
    );
    expect(reapproved.ok).toBe(false);
    organiser.close();
    repositories.close();
  }, 30_000);
});

/**
 * Spec review F4: an approval authorises a set of actions AT CURRENT STATE.
 * Every effect must revalidate; a mid-batch edit, rejection, taxonomy change
 * or expiry stops the remaining actions with zero further helper calls.
 */
describe('per-effect revalidation (F4)', () => {
  it('stops the batch when the durable taxonomy moves on mid-loop', async () => {
    const world: World = makeWorld('f4-taxonomy');
    const approval = world.approve();

    // After the first move lands, the user curates the taxonomy again.
    let moves = 0;
    const realMoveAt = world.helper.moveAt.bind(world.helper);
    world.helper.moveAt = async (action, root, destination) => {
      const result = await realMoveAt(action, root, destination);
      moves += 1;
      if (moves === 1) world.setTaxonomyRevision(2);
      return result;
    };

    const result = await world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash);
    expect(moves).toBe(1);
    expect(result.results[0]?.outcome).toBe('applied');
    const refused = result.results.slice(1);
    expect(refused.every((entry) => entry.outcome === 'stale')).toBe(true);
    expect(result.results.length).toBe(world.proposals.length);
  });

  it('stops the batch when a later proposal is rejected mid-loop', async () => {
    const world: World = makeWorld('f4-reject');
    const approval = world.approve();
    const second = world.proposals[1];
    expect(second).toBeDefined();

    let moves = 0;
    const realMoveAt = world.helper.moveAt.bind(world.helper);
    world.helper.moveAt = async (action, root, destination) => {
      const result = await realMoveAt(action, root, destination);
      moves += 1;
      if (moves === 1 && second !== undefined) {
        const stored = world.repositories.proposals.get(second.id);
        if (stored !== null) {
          world.repositories.proposals.save({ ...stored, state: 'rejected', version: stored.version + 1 });
        }
      }
      return result;
    };

    const result = await world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash);
    expect(moves).toBe(1);
    expect(result.results[0]?.outcome).toBe('applied');
    expect(result.results.slice(1).every((entry) => entry.outcome === 'stale')).toBe(true);
  });

  it('stops the batch when the approval expires mid-loop', async () => {
    const world: World = makeWorld('f4-expiry');
    const approval = world.approve();

    let moves = 0;
    const realMoveAt = world.helper.moveAt.bind(world.helper);
    world.helper.moveAt = async (action, root, destination) => {
      const result = await realMoveAt(action, root, destination);
      moves += 1;
      if (moves === 1) world.advance(25 * 60 * 60 * 1000);
      return result;
    };

    const result = await world.service.applyBatch(world.batch.id, approval.approvalId, approval.actionSetHash);
    expect(moves).toBe(1);
    expect(result.results[0]?.outcome).toBe('applied');
    expect(result.results.slice(1).every((entry) => entry.outcome === 'stale')).toBe(true);
  });
});

describe('proposal lifecycle (R4)', () => {
  it('regeneration keeps an edited version and does not revive its old approval', () => {
    const world: World = makeWorld('regeneration');
    const original = world.proposals[0];
    if (original === undefined) throw new Error('expected a seeded proposal');

    // A manual correction bumps the version and changes the destination.
    const patched: Proposal = {
      ...original,
      version: 2,
      categoryId: 'cat-media',
      destinationId: 'dest-media',
      state: 'pending',
    };
    world.repositories.proposals.save(patched);
    expect(world.repositories.proposals.get(original.id)?.version).toBe(2);

    // Re-classification reproduces the same deterministic id at version 1:
    // the stored correction must survive and no approval may bind version 1.
    world.repositories.proposals.save(original);
    const stored = world.repositories.proposals.get(original.id);
    expect(stored?.version).toBe(2);
    expect(stored?.destinationId).toBe('dest-media');
    expect(stored?.state).toBe('pending');

    const stale = world.service.createApproval(
      world.batch.id,
      [{ proposalId: original.id, version: 1 }],
      'apply',
      new Date('2026-10-07T10:00:00.000Z'),
    );
    expect(stale.ok).toBe(false);
  });

  it('persists a rejection and refuses approvals for rejected proposals', async () => {
    const { dbPath, rootDir } = tempWorld('reject');
    writeFileSync(join(rootDir, 'invoice-01.txt'), 'first invoice\n', 'utf8');
    const repositories = createRepositories(dbPath);
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    const scanned = await organiser.scan();
    const taxonomy = organiser.getTaxonomy();
    if (!taxonomy.ok) throw new Error(taxonomy.detail);
    const destinationId = taxonomy.value.tree.find((category) => category.kind === 'existing')?.destinationId ?? '';
    const proposal = seedProposal(repositories, scanned.rootId, 'invoice-01.txt', 'first invoice\n', destinationId, taxonomy.value.revision);
    const batchId = repositories.batches.listByRoot(scanned.rootId)[0]?.id ?? '';

    const rejected = await organiser.patchProposal(proposal.id, { expectedVersion: 1, reject: true });
    expect(rejected.ok).toBe(true);
    // The rejection must survive a reload, not just the response.
    expect(repositories.proposals.get(proposal.id)?.state).toBe('rejected');

    const approval = organiser.service.createApproval(
      batchId,
      [{ proposalId: proposal.id, version: rejected.ok ? rejected.value.version : 2 }],
      'apply',
      new Date('2026-10-07T10:00:00.000Z'),
    );
    expect(approval.ok).toBe(false);
    if (!approval.ok) expect(approval.code).toBe('STALE');
    organiser.close();
    repositories.close();
  }, 30_000);
});
