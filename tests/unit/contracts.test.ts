import { describe, expect, it } from 'vitest';
import {
  validateChoiceAnswer,
  validateSnapshot,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type Snapshot,
} from '../../src/domain/contracts.js';
import { CollectionFixtureSource } from '../fixtures/collection-source.js';

const hex64 = 'a'.repeat(64);
// Deliberately above Number.MAX_SAFE_INTEGER (9007199254740991).
const hugeInode = '9999999999999999999999999999999123';

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    device: '65026',
    inode: hugeInode,
    size: '1048576',
    mtimeNs: '1760000000123456789',
    ctimeNs: '1760000000123456789',
    sha256: hex64,
    ...overrides,
  };
}

function question(): ChoiceQuestion {
  return {
    id: 'q-inbox-root',
    instruction: 'Select the destination folder for this file.',
    options: [
      { id: 'cat-docs', description: 'Documents' },
      { id: 'cat-media', description: 'Media' },
      { id: 'unknown', description: 'Unknown' },
    ],
  };
}

function answer(overrides: Partial<ChoiceAnswer> = {}): ChoiceAnswer {
  return {
    questionId: 'q-inbox-root',
    selectedId: 'cat-docs',
    probabilities: { 'cat-docs': 1, 'cat-media': 0, unknown: 0 },
    providerConfidence: null,
    ...overrides,
  };
}

describe('validateSnapshot', () => {
  it('accepts decimal-string stats including values above MAX_SAFE_INTEGER', () => {
    const result = validateSnapshot(snapshot());
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it('rejects stat fields supplied as numbers (precision-loss risk)', () => {
    const result = validateSnapshot(
      snapshot({ inode: 9007199254740993 as unknown as string }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_DECISION');
  });

  it('rejects exponent notation and non-decimal stat strings', () => {
    for (const bad of ['1.2e12', '0x1f', '-1', '12.5', '']) {
      const result = validateSnapshot(snapshot({ size: bad }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_DECISION');
    }
  });

  it('rejects a malformed sha256', () => {
    const result = validateSnapshot(snapshot({ sha256: 'not-hex' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_DECISION');
  });
});

describe('validateChoiceAnswer', () => {
  it('accepts a valid degenerate distribution', () => {
    const result = validateChoiceAnswer(answer(), question());
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it('rejects a NaN probability', () => {
    const result = validateChoiceAnswer(
      answer({ probabilities: { 'cat-docs': Number.NaN, 'cat-media': 0, unknown: 0 } }),
      question(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_DECISION');
  });

  it('rejects probabilities outside [0, 1]', () => {
    for (const p of [1.5, -0.1]) {
      const result = validateChoiceAnswer(
        answer({ probabilities: { 'cat-docs': p, 'cat-media': 0, unknown: 1 - 0.5 } }),
        question(),
      );
      expect(result.ok).toBe(false);
    }
  });

  it('rejects a probability sum of 0.8', () => {
    const result = validateChoiceAnswer(
      answer({ probabilities: { 'cat-docs': 0.5, 'cat-media': 0.3, unknown: 0 } }),
      question(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_DECISION');
  });

  it('rejects a distribution missing an option ID', () => {
    const result = validateChoiceAnswer(
      answer({ probabilities: { 'cat-docs': 1, 'cat-media': 0 } }),
      question(),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown probability key not present in the question options', () => {
    const result = validateChoiceAnswer(
      answer({
        probabilities: { 'cat-docs': 0.5, 'cat-media': 0.5, unknown: 0, 'cat-evil': 0 },
      }),
      question(),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a selected ID that is not a maximum-probability option', () => {
    const result = validateChoiceAnswer(
      answer({
        selectedId: 'cat-media',
        probabilities: { 'cat-docs': 0.9, 'cat-media': 0.1, unknown: 0 },
      }),
      question(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_DECISION');
  });

  it('rejects an unknown selected ID', () => {
    const result = validateChoiceAnswer(
      answer({ selectedId: 'cat-evil', probabilities: { 'cat-evil': 1 } }),
      question(),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects an answer for a different question', () => {
    const result = validateChoiceAnswer(answer({ questionId: 'q-other' }), question());
    expect(result.ok).toBe(false);
  });

  it('accepts any maximal option on a tie (ties break lexically downstream)', () => {
    const result = validateChoiceAnswer(
      answer({
        selectedId: 'cat-media',
        probabilities: { 'cat-docs': 0.5, 'cat-media': 0.5, unknown: 0 },
      }),
      question(),
    );
    expect(result).toEqual({ ok: true, value: undefined });
  });
});

describe('CollectionFixtureSource (FR-14 read-only second source)', () => {
  it('advertises no actions and no recovery', () => {
    const source = new CollectionFixtureSource([{ externalId: 'bm-1' }]);
    expect(source.capabilities()).toEqual({ actions: [], recovery: 'none' });
  });

  it('discover yields normalised collection items without filesystem access', async () => {
    const source = new CollectionFixtureSource([{ externalId: 'bm-1' }, { externalId: 'bm-2' }]);
    const items = [];
    for await (const result of source.discover({
      rootId: 'fixture-root',
      absolutePath: '/nonexistent-fixture-path',
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
      expect(item.revision).toBe('1');
      expect(item.evidenceId).toBeTruthy();
    }
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
  });

  it('inspect is unsupported: a collection has no filesystem identity', async () => {
    const source = new CollectionFixtureSource([{ externalId: 'bm-1' }]);
    const result = await source.inspect('whatever');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED');
  });

  it('apply is rejected as UNSUPPORTED without invoking any filesystem helper', async () => {
    const source = new CollectionFixtureSource([{ externalId: 'bm-1' }]);
    const result = await source.apply({
      kind: 'move_file',
      actionId: 'a-1',
      rootId: 'fixture-root',
      sourceBasename: 'invoice.txt',
      destinationSegments: ['Documents'],
      expected: snapshot(),
      approvalId: 'appr-1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED');
  });
});
