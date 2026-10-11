import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Decision, DecisionProvider, DecisionRequest, ProviderManifest, Result } from '../../src/domain/contracts.js';
import { loadDataset, loadLabels } from '../../src/eval/dataset.js';
import { runEvaluation } from '../../src/eval/runner.js';

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'eval');

const outDirs: string[] = [];
afterAll(() => {
  for (const dir of outDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Spec review R11: a matched treatment must feed every compared provider the
 * SAME fitted evidence. These two providers declare different input budgets;
 * the run must fit both to the tightest common budget and the journalled
 * request hashes must be identical per item.
 */
class FixedBudgetProvider implements DecisionProvider {
  readonly providerId: 'rules' | 'laya';
  readonly captured: DecisionRequest[] = [];

  constructor(providerId: 'rules' | 'laya', private readonly inputTokenLimit: number | null) {
    this.providerId = providerId;
  }

  async health(): Promise<Result<ProviderManifest>> {
    return {
      ok: true,
      value: {
        provider: this.providerId,
        modelRevision: `budget-${this.inputTokenLimit ?? 'none'}`,
        runtimeRevision: 'test',
        tokenizerRevision: 'test',
        questionTokenLimit: 192,
        inputTokenLimit: this.inputTokenLimit,
        endpoint: null,
      },
    };
  }

  async decide(request: DecisionRequest): Promise<Result<Decision>> {
    this.captured.push(request);
    // A degenerate but valid distribution: the first option.
    const question = request.questions[0];
    const first = question?.options[0]?.id ?? '';
    const probabilities: Record<string, number> = {};
    for (const option of question?.options ?? []) {
      probabilities[option.id] = option.id === first ? 1 : 0;
    }
    return {
      ok: true,
      value: {
        id: `decision-${question?.id ?? 'q'}`,
        itemId: request.evidence.itemId,
        provider: this.providerId,
        modelRevision: `budget-${this.inputTokenLimit ?? 'none'}`,
        runtimeRevision: 'test',
        evidenceHash: request.evidence.stateHash,
        schemaHash: request.schemaHash,
        answers: [
          { questionId: question?.id ?? 'q', selectedId: first, probabilities, providerConfidence: 1 },
        ],
        elapsedMs: 1,
        tokenCounts: { input: 10 },
        error: null,
      },
    };
  }

  async close(): Promise<void> {}
}

function hashOf(request: DecisionRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        evidence: request.evidence,
        questions: request.questions,
        schemaHash: request.schemaHash,
        taxonomyRevision: request.taxonomyRevision,
      }),
    )
    .digest('hex');
}

describe('matched treatments (R11)', () => {
  it('feeds every compared provider the identical fitted request', async () => {
    const dataset = loadDataset(FIXTURE);
    expect(dataset.ok).toBe(true);
    if (!dataset.ok) return;
    loadLabels(FIXTURE);

    const tight = new FixedBudgetProvider('rules', 120);
    const loose = new FixedBudgetProvider('laya', 4096);
    const run = await runEvaluation(dataset.value, [tight, loose], {
      split: 'all',
      evidenceTreatment: 'compact_text',
      warmRepeats: 0,
      provenance: 'synthetic-fixture',
    });
    expect(run.provenance).toBe('synthetic-fixture');

    // The same item reached both providers with the same journalled hash:
    // matched inputs, recorded per question rather than asserted.
    const tightByItem = new Map(tight.captured.map((request) => [request.evidence.itemId, hashOf(request)]));
    for (const request of loose.captured) {
      const tightHash = tightByItem.get(request.evidence.itemId);
      expect(tightHash).toBeDefined();
      expect(hashOf(request)).toBe(tightHash);
    }
    // Both providers' records carry the same request hashes in their routes.
    for (const prediction of run.predictions) {
      for (const step of prediction.route) {
        expect(step.requestHash).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    const rulesRoutes = run.predictions.filter((row) => row.provider === 'rules');
    const layaRoutes = run.predictions.filter((row) => row.provider === 'laya');
    expect(rulesRoutes.length).toBe(layaRoutes.length);
    for (const row of rulesRoutes) {
      const counterpart = layaRoutes.find((entry) => entry.itemId === row.itemId);
      expect(counterpart?.route.map((step) => step.requestHash)).toEqual(row.route.map((step) => step.requestHash));
    }
  }, 120_000);
});
