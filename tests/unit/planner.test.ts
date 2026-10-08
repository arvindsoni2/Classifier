import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  stableStringify,
  UNKNOWN_OPTION_ID,
  type Category,
  type Decision,
  type Destination,
  type Item,
  type Proposal,
  type Snapshot,
  type Vocabulary,
} from '../../src/domain/contracts.js';
import type { Batch } from '../../src/adapters/persistence/repositories.js';
import { patchProposal, rejectProposal } from '../../src/domain/policy.js';
import {
  createApproval,
  planPlacement,
  suggestFolderGroups,
  validateApproval,
} from '../../src/domain/planner.js';
import { validateTaxonomy, type Taxonomy } from '../../src/domain/taxonomy.js';

const sha256 = (input: string) => createHash('sha256').update(input).digest('hex');
const POLICY_REVISION = 3;

const snapshot: Snapshot = {
  device: '65026',
  inode: '123456789012345678901234567890',
  size: '2048',
  mtimeNs: '1760000000123456789',
  ctimeNs: '1760000000123456789',
  sha256: 'c'.repeat(64),
};

function item(externalId: string): Item {
  return {
    id: `item-${externalId}`,
    sourceId: 'root-1',
    sourceKind: 'filesystem',
    externalId,
    displayName: externalId,
    revision: sha256(externalId),
    snapshot,
    evidenceId: 'evidence-1',
  };
}

function tree(): Category[] {
  return [
    { id: 'root', parentId: null, label: 'Inbox', description: 'Root', destinationId: null, kind: 'group' },
    { id: 'cat-invoices', parentId: 'root', label: 'Invoices', description: 'Invoice and billing documents', destinationId: 'dest-invoices', kind: 'existing' },
    { id: 'cat-media', parentId: 'root', label: 'Media', description: 'Photos, video and audio', destinationId: 'dest-media', kind: 'existing' },
    { id: 'cat-docs', parentId: 'root', label: 'Documents', description: 'Documents', destinationId: 'dest-docs', kind: 'existing' },
  ];
}

function taxonomy(): Taxonomy {
  const destinations: Destination[] = [
    { id: 'dest-invoices', segments: ['Invoices'], device: '65026', inode: '900001', status: 'observed' },
    { id: 'dest-media', segments: ['Media'], device: '65026', inode: '900002', status: 'observed' },
    { id: 'dest-docs', segments: ['Documents'], device: '65026', inode: '900003', status: 'observed' },
  ];
  const result = validateTaxonomy(tree(), destinations);
  if (!result.ok) throw new Error(result.detail);
  return result.value;
}

function decision(itemId: string, selectedId: string, _family = 'family-a'): Decision {
  const stateHash = sha256(`${itemId}:${selectedId}`);
  return {
    id: `decision-${itemId}`,
    itemId,
    provider: 'rules',
    modelRevision: 'rules@1.0.0',
    runtimeRevision: 'v22.23.2',
    evidenceHash: stateHash,
    schemaHash: sha256('schema'),
    answers: [
      {
        questionId: 'q-root',
        selectedId,
        probabilities: { [selectedId]: 1 },
        providerConfidence: null,
      },
    ],
    elapsedMs: 0,
    tokenCounts: {},
    error: null,
  } as Decision;
}

function batch(id = 'batch-1'): Batch {
  return { id, rootId: 'root-1', stage: 'review', createdAt: '2026-10-07T10:00:00.000Z', cancellationRequested: false };
}

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  const source = { ...item('invoice-2026.pdf'), ...overrides };
  return {
    id: source.id,
    version: 1,
    itemId: source.id,
    categoryId: 'cat-invoices',
    destinationId: 'dest-invoices',
    basename: source.externalId,
    expected: snapshot,
    taxonomyRevision: 1,
    policyRevision: POLICY_REVISION,
    decisionIds: ['decision-1'],
    state: 'pending',
    ...overrides,
  };
}

describe('planPlacement — unknown cannot plan', () => {
  it('returns no proposal when the route defers to unknown', () => {
    const result = planPlacement(item('invoice-2026.pdf'), {
      answers: [{ nodeId: 'root', questionId: 'q-root', selectedId: UNKNOWN_OPTION_ID }],
    }, taxonomy(), POLICY_REVISION);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_DECISION');
  });

  it('returns no proposal when the route selects a category that does not exist', () => {
    const result = planPlacement(item('invoice-2026.pdf'), {
      answers: [{ nodeId: 'root', questionId: 'q-root', selectedId: 'cat-nope' }],
    }, taxonomy(), POLICY_REVISION);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_DECISION');
  });

  it('returns no proposal when the route ends at a group instead of an existing category', () => {
    const result = planPlacement(item('invoice-2026.pdf'), {
      answers: [{ nodeId: 'root', questionId: 'q-root', selectedId: 'cat-invoices' }],
    }, taxonomy(), POLICY_REVISION);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.destinationId).toBe('dest-invoices');
  });

  it('plans with the original basename and the expected snapshot', () => {
    const result = planPlacement(item('invoice-2026.pdf'), {
      answers: [{ nodeId: 'root', questionId: 'q-root', selectedId: 'cat-invoices' }],
    }, taxonomy(), POLICY_REVISION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const planned = result.value;
    expect(planned.version).toBe(1);
    expect(planned.state).toBe('pending');
    expect(planned.basename).toBe('invoice-2026.pdf');
    expect(planned.expected).toEqual(snapshot);
    expect(planned.policyRevision).toBe(POLICY_REVISION);
    expect(planned.taxonomyRevision).toBe(taxonomy().revision);
    expect(planned.destinationId).toBe('dest-invoices');
    expect(planned.id).toMatch(/^proposal-/);
  });

  it('refuses to plan an item without a verified snapshot', () => {
    const noSnapshot: Item = { ...item('invoice-2026.pdf'), snapshot: null };
    const result = planPlacement(noSnapshot, {
      answers: [{ nodeId: 'root', questionId: 'q-root', selectedId: 'cat-invoices' }],
    }, taxonomy(), POLICY_REVISION);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNSTABLE');
  });
});

describe('suggestFolderGroups (FR-06)', () => {
  const vocabulary: Vocabulary = {
    maxLabelLength: 24,
    labelPattern: '^[A-Za-z][A-Za-z0-9 -]*$',
    reservedNames: ['System', 'Downloads'],
  };

  it('requires at least three members for a suggestion', () => {
    const items = [item('a.pdf'), item('b.pdf'), item('c.pdf')];
    const decisions = items.map((i) => decision(i.id, UNKNOWN_OPTION_ID));
    const candidates = suggestFolderGroups(items, decisions, vocabulary);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.members).toHaveLength(3);
    expect(candidates[0]?.reviewState).toBe('draft');
    expect(candidates[0]?.destinationParentId).toBeNull();
  });

  it('emits no suggestion for two unclassified members unless the user requested one', () => {
    const items = [item('a.pdf'), item('b.pdf')];
    const decisions = items.map((i) => decision(i.id, UNKNOWN_OPTION_ID));
    expect(suggestFolderGroups(items, decisions, vocabulary)).toHaveLength(0);
    const requested = suggestFolderGroups(items, decisions, vocabulary, { userRequested: true });
    expect(requested).toHaveLength(1);
    expect(requested[0]?.createdBy).toBe('user');
  });

  it('uses controlled names and drops groups with no legal label', () => {
    const items = [item('a.pdf'), item('b.pdf'), item('c.pdf')];
    const decisions = items.map((i) => decision(i.id, UNKNOWN_OPTION_ID));
    const strictVocabulary: Vocabulary = {
      maxLabelLength: 3,
      labelPattern: '^[A-Z][a-z]*$',
      reservedNames: [],
    };
    // 'Unsorted Documents' exceeds three characters: no legal label exists.
    expect(suggestFolderGroups(items, decisions, strictVocabulary)).toHaveLength(0);

    const legal: Vocabulary = { maxLabelLength: 40, labelPattern: '^[A-Z][a-z]*( [A-Z][a-z]*)*$', reservedNames: ['Downloads'] };
    const suggestions = suggestFolderGroups(items, decisions, legal);
    expect(suggestions).toHaveLength(1);
    expect(new RegExp(legal.labelPattern).test(suggestions[0]?.label ?? '')).toBe(true);
  });
});

describe('createApproval / validateApproval — exact binding and expiry', () => {
  const now = new Date('2026-10-07T10:00:00.000Z');
  const selected = [proposal({ id: 'proposal-1' }), proposal({ id: 'proposal-2', itemId: 'item-2', basename: 'invoice-2026-02.pdf' })];

  it('binds exact action versions with a deterministic action-set hash', () => {
    const first = createApproval(batch(), selected, 'apply', now);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.actions).toEqual([      { proposalId: 'proposal-1', version: 1 },
      { proposalId: 'proposal-2', version: 1 },
    ]);
    expect(first.value.actionSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.value.approvedAt).toBe('2026-10-07T10:00:00.000Z');
    // 24-hour expiry.
    expect(first.value.expiresAt).toBe('2026-10-08T10:00:00.000Z');
    expect(first.value.mode).toBe('apply');

    // The same selection always hashes the same way.
    const again = createApproval(batch(), selected, 'apply', now);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.actionSetHash).toBe(first.value.actionSetHash);

    // A different selection hashes differently.
    const other = createApproval(batch(), [selected[0]!], 'apply', now);
    expect(other.ok).toBe(true);
    if (other.ok) expect(other.value.actionSetHash).not.toBe(first.value.actionSetHash);
  });

  it('rejects taxonomies, policies, action versions and expiry that changed', () => {
    const approvalResult = createApproval(batch(), selected, 'apply', now);
    if (!approvalResult.ok) throw new Error(approvalResult.detail);
    const approval = approvalResult.value;

    const context = (overrides: Partial<Parameters<typeof validateApproval>[1]> = {}) => ({
      taxonomyRevision: taxonomy().revision,
      policyRevision: POLICY_REVISION,
      actions: [
        { proposalId: 'proposal-1', version: 1 },
        { proposalId: 'proposal-2', version: 1 },
      ],
      ...overrides,
    });

    expect(validateApproval(approval, context(), now).ok).toBe(true);

    // 24-hour expiry rejects.
    const expired = validateApproval(approval, context(), new Date('2026-10-08T10:00:01.000Z'));
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.code).toBe('STALE');

    // Taxonomy change invalidates.
    const taxonomyChanged = validateApproval(
      approval,
      context({ taxonomyRevision: taxonomy().revision + 1 }),
      now,
    );
    expect(taxonomyChanged.ok).toBe(false);
    if (!taxonomyChanged.ok) expect(taxonomyChanged.code).toBe('STALE');

    // Policy change invalidates.
    const policyChanged = validateApproval(approval, context({ policyRevision: POLICY_REVISION + 1 }), now);
    expect(policyChanged.ok).toBe(false);
    if (!policyChanged.ok) expect(policyChanged.code).toBe('STALE');

    // A bound action version changed (e.g. the user edited the placement).
    const versionChanged = validateApproval(
      approval,
      context({
        actions: [
          { proposalId: 'proposal-1', version: 2 },
          { proposalId: 'proposal-2', version: 1 },
        ],
      }),
      now,
    );
    expect(versionChanged.ok).toBe(false);
    if (!versionChanged.ok) {
      expect(versionChanged.code).toBe('STALE');
      expect(versionChanged.detail).toMatch(/action set|versions/i);
    }
  });
});

describe('patchProposal (manual corrections, FR-12)', () => {
  it('increments the version on an accepted edit and rejects stale expected versions', () => {
    const patched = patchProposal(proposal(), { expectedVersion: 1, categoryId: 'cat-media', destinationId: 'dest-media' });
    expect(patched.ok).toBe(true);
    if (patched.ok) {
      expect(patched.value.version).toBe(2);
      expect(patched.value.categoryId).toBe('cat-media');
      expect(patched.value.destinationId).toBe('dest-media');
    }

    const stale = patchProposal(proposal(), { expectedVersion: 7, categoryId: 'cat-media' });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('STALE');
  });

  it('rejects a proposal and increments its version', () => {
    const rejected = rejectProposal(proposal(), 1);
    expect(rejected.ok).toBe(true);
    if (rejected.ok) {
      expect(rejected.value.state).toBe('rejected');
      expect(rejected.value.version).toBe(2);
    }
    const stale = rejectProposal(proposal(), 5);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('STALE');
  });

  it('assumes deterministic ids for identical proposals', () => {
    const first = planPlacement(item('invoice-2026.pdf'), { answers: [{ nodeId: 'root', questionId: 'q-root', selectedId: 'cat-invoices' }] }, taxonomy(), POLICY_REVISION);
    const second = planPlacement(item('invoice-2026.pdf'), { answers: [{ nodeId: 'root', questionId: 'q-root', selectedId: 'cat-invoices' }] }, taxonomy(), POLICY_REVISION);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.id).toBe(second.value.id);
      expect(sha256(stableStringify(first.value))).toBe(sha256(stableStringify(second.value)));
    }
  });
});
