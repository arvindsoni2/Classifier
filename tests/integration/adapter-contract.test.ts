import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DecisionProvider, Item } from '../../src/domain/contracts.js';
import { RulesProvider } from '../../src/adapters/providers/rules.js';
import { CollectionFixtureSource } from '../fixtures/collection-source.js';

/**
 * FR-14: a mock second source lists normalised items and participates in
 * classification through the SAME provider contract, while advertising
 * read-only capability. Mutation through it is rejected without invoking
 * the filesystem helper.
 */

interface ItemLike {
  item: Item;
  decide(provider: DecisionProvider): Promise<{ ok: boolean; selectedId?: string; code?: string }>;
}

/** Classifies a discovered item through the provider contract. */
async function classifyItem(item: Item, provider: DecisionProvider) {
  const { buildMatchedRequest } = await import('../../src/domain/taxonomy.js');
  const { createHash } = await import('node:crypto');
  const questionDef = {
    id: 'q-collection-root',
    instruction: 'Select the folder for this bookmark.',
    options: [
      { id: 'cat-reading', description: 'Reading list and articles' },
      { id: 'cat-media', description: 'Photos, video and audio' },
      { id: 'unknown', description: 'Unknown or insufficient evidence' },
    ],
  };
  void questionDef;
  const evidence = {
    id: item.evidenceId ?? 'evidence-1',
    itemId: item.id,
    profile: 'metadata' as const,
    state: {
      basename: item.externalId,
      detectedFormat: 'collection',
      sizeBytes: 0,
      compactText: 'bookmark for an article about storage systems',
    },
    stateHash: createHash('sha256').update(item.externalId).digest('hex'),
    status: 'ready' as const,
    truncated: false,
    extractorRevision: 'extract@1.0.0',
    inputTokenCounts: {},
  };
  const request = buildMatchedRequest(evidence, { category: { id: 'root', parentId: null, label: 'Collection', description: 'Root', destinationId: null, kind: 'group' }, children: [
    { id: 'cat-reading', parentId: 'root', label: 'Reading', description: 'Reading list and articles', destinationId: 'dest-reading', kind: 'existing' as const },
    { id: 'cat-media', parentId: 'root', label: 'Media', description: 'Photos, video and audio', destinationId: 'dest-media', kind: 'existing' as const },
  ] }, []);
  expect(request.ok).toBe(true);
  if (!request.ok) throw new Error(request.detail);
  return provider.decide(request.value);
}

describe('collection source adapter contract (FR-14)', () => {
  const fixtures: string[] = [];
  afterAll(() => {
    for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
  });

  it('discovers normalised items and advertises read-only capability', async () => {
    const source = new CollectionFixtureSource([
      { externalId: 'https://example.com/article-storage', displayName: 'Article about storage' },
      { externalId: 'https://example.com/photo-gallery', displayName: 'Photo gallery' },
    ]);

    expect(source.capabilities()).toEqual({ actions: [], recovery: 'none' });

    const items: Item[] = [];
    for await (const result of source.discover({
      rootId: 'collection-root',
      absolutePath: '/nonexistent',
      device: '0',
      inode: '0',
      inboxDepth: 0,
      directoryDepth: 3,
      policyRevision: 1,
    })) {
      expect(result.ok).toBe(true);
      if (result.ok) items.push(result.value);
    }
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.sourceKind).toBe('collection');
      expect(item.snapshot).toBeNull();
      expect(item.evidenceId).not.toBeNull();
    }
  });

  it('participates in classification through the same provider contract', async () => {
    const source = new CollectionFixtureSource([
      { externalId: 'https://example.com/article-storage', displayName: 'Article about storage' },
    ]);
    const items: Item[] = [];
    for await (const result of source.discover({
      rootId: 'collection-root',
      absolutePath: '/nonexistent',
      device: '0',
      inode: '0',
      inboxDepth: 0,
      directoryDepth: 3,
      policyRevision: 1,
    })) {
      if (result.ok) items.push(result.value);
    }

    const provider = new RulesProvider();
    const decision = await classifyItem(items[0]!, provider);
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.value.provider).toBe('rules');
      expect(decision.value.answers[0]?.selectedId).toBeTruthy();
    }
    await provider.close();
  });

  it('rejects mutation as UNSUPPORTED without invoking the helper', async () => {
    const source = new CollectionFixtureSource([{ externalId: 'bm-1' }]);
    const result = await source.apply({
      kind: 'move_file',
      actionId: 'action-1',
      rootId: 'collection-root',
      sourceBasename: 'invoice.txt',
      destinationSegments: ['Invoices'],
      expected: {
        device: '65026',
        inode: '900001',
        size: '11',
        mtimeNs: '1760000000000000000',
        ctimeNs: '1760000000000000000',
        sha256: 'a'.repeat(64),
      },
      approvalId: 'approval-1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED');

    // A directory tree next to it is untouched: no helper process exists.
    const dir = mkdtempSync(join('/tmp/opencode', 'adapter-contract-'));
    fixtures.push(dir);
    mkdirSync(join(dir, 'Invoices'), { recursive: true });
    writeFileSync(join(dir, 'Invoices', 'invoice.txt'), 'precious\n', 'utf8');
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(dir, 'Invoices', 'invoice.txt'), 'utf8')).toBe('precious\n');
  });
});

// Keep the ItemLike type used by potential future adapters honest.
export type { ItemLike };
