import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  stableStringify,
  UNKNOWN_OPTION_ID,
  type Category,
  type Destination,
  type Evidence,
  type ProviderManifest,
  type Result,
} from '../../src/domain/contracts.js';
import {
  buildMatchedRequest,
  validateTaxonomy,
  type TaxonomyNode,
} from '../../src/domain/taxonomy.js';

const hex64 = /^[0-9a-f]{64}$/;

function destination(id: string): Destination {
  return { id, segments: [id.replace(/^dest-/, '')], device: '65026', inode: '998877', status: 'observed' };
}

function category(
  id: string,
  parentId: string | null,
  kind: Category['kind'],
  label: string,
  destinationId: string | null = null,
): Category {
  return { id, parentId, label, description: `${label} folder`, destinationId, kind };
}

function validTree(): Category[] {
  return [
    category('root', null, 'group', 'Inbox'),
    category('cat-docs', 'root', 'existing', 'Documents', 'dest-docs'),
    category('cat-media', 'root', 'existing', 'Media', 'dest-media'),
    category('cat-career', 'root', 'existing', 'Career', 'dest-career'),
    category('cat-software', 'root', 'existing', 'Software', 'dest-software'),
    category('cat-finance', 'root', 'existing', 'Finance', 'dest-finance'),
    category('cat-personal', 'root', 'existing', 'Personal', 'dest-personal'),
    category('cat-archive', 'root', 'existing', 'Archive', 'dest-archive'),
  ];
}

function validDestinations(): Destination[] {
  return [
    destination('dest-docs'),
    destination('dest-media'),
    destination('dest-career'),
    destination('dest-software'),
    destination('dest-finance'),
    destination('dest-personal'),
    destination('dest-archive'),
  ];
}

function makeEvidence(compactText?: string): Evidence {
  const state: Record<string, unknown> = {
    basename: 'invoice-2026-q3.pdf',
    detectedFormat: 'pdf',
    sizeBytes: 1024,
  };
  if (compactText !== undefined) state.compactText = compactText;
  return {
    id: 'evidence-1',
    itemId: 'item-1',
    profile: compactText === undefined ? 'metadata' : 'compact_text',
    state,
    stateHash: createHash('sha256').update(stableStringify(state)).digest('hex'),
    status: 'ready',
    truncated: false,
    extractorRevision: 'extract@1.0.0',
    inputTokenCounts: {},
  };
}

function manifest(overrides: Partial<ProviderManifest>): ProviderManifest {
  return {
    provider: 'rules',
    modelRevision: 'fixture',
    runtimeRevision: 'fixture',
    tokenizerRevision: 'fixture',
    questionTokenLimit: null,
    inputTokenLimit: null,
    endpoint: null,
    ...overrides,
  };
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`unexpected error: ${result.code}: ${result.detail}`);
  return result.value;
}

describe('validateTaxonomy', () => {
  it('accepts a valid tree, passes category IDs through unchanged and hashes stably', () => {
    const first = validateTaxonomy(validTree(), validDestinations());
    const taxonomy = unwrap(first);
    expect(taxonomy.mappingHash).toMatch(hex64);
    // IDs are immutable identifiers: they pass through exactly as supplied.
    expect(taxonomy.tree.map((c) => c.id).sort()).toEqual(validTree().map((c) => c.id).sort());

    const second = unwrap(validateTaxonomy(validTree(), validDestinations()));
    expect(second.mappingHash).toBe(taxonomy.mappingHash);

    // Editing a label changes the mapping hash (FR-02) without inventing IDs.
    const relabeled = validTree();
    const docs = relabeled.find((c) => c.id === 'cat-docs');
    if (docs) docs.label = 'Documents and Writing';
    const third = unwrap(validateTaxonomy(relabeled, validDestinations()));
    expect(third.mappingHash).not.toBe(taxonomy.mappingHash);
    expect(third.tree.find((c) => c.id === 'cat-docs')?.label).toBe('Documents and Writing');
  });

  it('rejects more than seven children per node', () => {
    const tree = validTree();
    tree.push(category('cat-8th', 'root', 'existing', 'Eighth', 'dest-docs'));
    tree.push(category('cat-9th', 'root', 'existing', 'Ninth', 'dest-media'));
    const result = validateTaxonomy(tree, validDestinations());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_DECISION');
      expect(result.detail).toContain('children');
    }
  });

  it('rejects route trees deeper than four levels', () => {
    const tree = validTree();
    tree.push(category('level-2', 'cat-docs', 'group', 'Level two'));
    tree.push(category('level-3', 'level-2', 'group', 'Level three'));
    tree.push(category('level-4', 'level-3', 'group', 'Level four'));
    tree.push(category('level-5', 'level-4', 'existing', 'Level five', 'dest-docs'));
    const result = validateTaxonomy(tree, validDestinations());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/depth|route/i);
  });

  it('rejects parent cycles explicitly', () => {
    const tree = validTree();
    const root = tree.find((c) => c.id === 'root');
    if (root) root.parentId = 'cat-docs';
    const result = validateTaxonomy(tree, validDestinations());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('cycle');
  });

  it('rejects existing categories mapped to unknown destinations', () => {
    const tree = validTree();
    const docs = tree.find((c) => c.id === 'cat-docs');
    if (docs) docs.destinationId = 'dest-does-not-exist';
    const result = validateTaxonomy(tree, validDestinations());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('destination');
  });

  it('rejects duplicate IDs, reserved IDs and groups with destinations', () => {
    const dup = validTree();
    dup.push(category('cat-docs', 'root', 'existing', 'Duplicate', 'dest-docs'));
    const dupResult = validateTaxonomy(dup, validDestinations());
    expect(dupResult.ok).toBe(false);
    if (!dupResult.ok) expect(dupResult.detail).toContain('duplicate');

    const reserved = validTree();
    reserved.push(category(UNKNOWN_OPTION_ID, 'root', 'existing', 'Reserved', 'dest-docs'));
    const reservedResult = validateTaxonomy(reserved, validDestinations());
    expect(reservedResult.ok).toBe(false);
    if (!reservedResult.ok) expect(reservedResult.detail).toContain('reserved');

    const tree = validTree();
    const root = tree.find((c) => c.id === 'root');
    if (root) root.destinationId = 'dest-docs';
    const groupResult = validateTaxonomy(tree, validDestinations());
    expect(groupResult.ok).toBe(false);
    if (!groupResult.ok) expect(groupResult.detail).toContain('group');
  });
});

describe('buildMatchedRequest — requires_unknown_and_rejects_oversized_headers', () => {
  const node: TaxonomyNode = {
    category: category('root', null, 'group', 'Inbox'),
    children: validTree().filter((c) => c.parentId === 'root'),
  };

  it('adds the unknown option, records hashes and matches evidence across providers', () => {
    const evidence = makeEvidence('fixture invoice text for matched treatments');
    const manifests = [
      manifest({ provider: 'rules' }),
      manifest({ provider: 'laya', questionTokenLimit: 192, inputTokenLimit: 512 }),
      manifest({ provider: 'clef', questionTokenLimit: 256, inputTokenLimit: 1024, endpoint: 'http://127.0.0.1:11434' }),
    ];
    const request = unwrap(buildMatchedRequest(evidence, node, manifests));

    expect(request.questions).toHaveLength(1);
    const options = request.questions[0]?.options ?? [];
    expect(options.map((o) => o.id)).toEqual([
      'cat-archive',
      'cat-career',
      'cat-docs',
      'cat-finance',
      'cat-media',
      'cat-personal',
      'cat-software',
      UNKNOWN_OPTION_ID,
    ]);
    expect(request.schemaHash).toMatch(hex64);
    expect(request.evidence.stateHash).toMatch(hex64);

    // Identical semantic evidence and questions for every matched treatment:
    // the same manifests (any order) produce byte-identical request hashes.
    const reordered = [...manifests].reverse();
    const other = unwrap(buildMatchedRequest(evidence, node, reordered));
    expect(other.evidence.stateHash).toBe(request.evidence.stateHash);
    expect(other.schemaHash).toBe(request.schemaHash);
    expect(other.questions).toEqual(request.questions);
    expect(other.taxonomyRevision).toBe(request.taxonomyRevision);
  });

  it('returns INPUT_TOO_LONG when even metadata cannot fit a provider budget', () => {
    const evidence = makeEvidence('some compact text');
    const tight = [manifest({ provider: 'laya', questionTokenLimit: 192, inputTokenLimit: 5 })];
    const result = buildMatchedRequest(evidence, node, tight);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INPUT_TOO_LONG');
      expect(result.detail).toMatch(/metadata|does not fit/i);
    }
  });

  it('rejects oversized question headers against provider token limits', () => {
    const evidence = makeEvidence();
    const wordyNode: TaxonomyNode = {
      category: node.category,
      children: node.children.map((child) => ({
        ...child,
        description: `${child.label} ${'very long description '.repeat(30)}`,
      })),
    };
    const manifests = [manifest({ provider: 'laya', questionTokenLimit: 64, inputTokenLimit: 512 })];
    const result = buildMatchedRequest(evidence, wordyNode, manifests);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INPUT_TOO_LONG');
      expect(result.detail).toMatch(/header/i);
    }
  });

  it('caps compact text at 1200 characters and clips it further to the tightest budget', () => {
    const longText = 'invoice words '.repeat(400); // ~5600 characters
    const evidence = makeEvidence(longText);

    // No token limits (rules only): initial 1200-character cap applies.
    const capped = unwrap(buildMatchedRequest(evidence, node, [manifest({ provider: 'rules' })]));
    expect(String(capped.evidence.state.compactText).length).toBeLessThanOrEqual(1200);
    expect(capped.evidence.state.requestClipped).toBe(true);

    // Tighter budget: the text is shortened further until it fits, and the
    // clipping is recorded in the evidence state.
    const tightManifests = [
      manifest({ provider: 'rules' }),
      manifest({ provider: 'laya', questionTokenLimit: 192, inputTokenLimit: 120 }),
    ];
    const clipped = unwrap(buildMatchedRequest(evidence, node, tightManifests));
    const clippedText = String(clipped.evidence.state.compactText);
    expect(clippedText.length).toBeLessThanOrEqual(1200);
    expect(clippedText.length).toBeLessThan(String(capped.evidence.state.compactText).length);
    expect(clipped.evidence.state.requestClipped).toBe(true);
    // Same manifests, same clipped evidence: matched treatments stay identical.
    const again = unwrap(buildMatchedRequest(evidence, node, tightManifests));
    expect(again.evidence.stateHash).toBe(clipped.evidence.stateHash);
  });

  it('rejects option descriptions above the twelve-token option budget (LLD §3)', () => {
    const evidence = makeEvidence();
    const wordyNode: TaxonomyNode = {
      category: node.category,
      children: node.children.map((child, index) => ({
        ...child,
        // Only one over-long option; the header total still fits.
        description: index === 0 ? `word ${'padding '.repeat(20)}` : child.description,
      })),
    };
    const manifests = [manifest({ provider: 'laya', questionTokenLimit: 512, inputTokenLimit: 2048 })];
    const result = buildMatchedRequest(evidence, wordyNode, manifests);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INPUT_TOO_LONG');
      expect(result.detail).toMatch(/option|twelve|12/i);
    }
  });

  it('derives the request evidence id from its clipped state hash (no PK collision)', () => {
    const longText = 'invoice words '.repeat(400);
    const evidence = makeEvidence(longText);
    const originalId = evidence.id;
    const tight = [manifest({ provider: 'rules' }), manifest({ provider: 'laya', questionTokenLimit: 192, inputTokenLimit: 120 })];
    const clipped = unwrap(buildMatchedRequest(evidence, node, tight));
    expect(clipped.evidence.stateHash).not.toBe(evidence.stateHash);
    expect(clipped.evidence.id).not.toBe(originalId);
    const looser = [manifest({ provider: 'rules' })];
    const capped = unwrap(buildMatchedRequest(evidence, node, looser));
    expect(capped.evidence.id).not.toBe(clipped.evidence.id);
  });
});
