import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  stableStringify,
  type ChoiceQuestion,
  type Decision,
  type DecisionRequest,
  type Evidence,
  type Result,
} from '../../src/domain/contracts.js';
import { RulesProvider } from '../../src/adapters/providers/rules.js';
import { LayaProvider } from '../../src/adapters/providers/laya.js';
import { ClefProvider, type ClefTransport } from '../../src/adapters/providers/clef.js';
import { JevProvider } from '../../src/adapters/providers/jev.js';
import { probeProviders, type ProviderHealth } from '../../src/cli/doctor.js';

function makeEvidence(compactText?: string, basename = 'invoice-2026-q3.pdf'): Evidence {
  const state: Record<string, unknown> = {
    basename,
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

function question(): ChoiceQuestion {
  return {
    id: 'q-root',
    instruction: 'Select the destination folder for this file.',
    options: [
      { id: 'cat-invoices', description: 'Invoice and billing documents' },
      { id: 'cat-media', description: 'Photos, video and audio' },
      { id: 'unknown', description: 'Unknown or insufficient evidence' },
    ],
  };
}

function request(compactText = 'fixture invoice text', basename?: string): DecisionRequest {
  const q = question();
  return {
    evidence: makeEvidence(compactText, basename),
    questions: [q],
    schemaHash: createHash('sha256').update(stableStringify(q)).digest('hex'),
    taxonomyRevision: 1,
  };
}

/** Well-formed SystemOne response fixture for the canonical question. */
function systemOneResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'clef-flash-fixture-gguf',
    answers: {
      'q-root': {
        type: 'choice',
        choice: 'cat-invoices',
        probabilities: { 'cat-invoices': 0.82, 'cat-media': 0.08, unknown: 0.1 },
        confidence: 0.82,
      },
    },
    usage: { input_tokens: 120, output_tokens: 0 },
    ...overrides,
  };
}

/** Replaces only the canonical answer inside a response fixture. */
function withAnswer(answer: Record<string, unknown>): Record<string, unknown> {
  return { ...systemOneResponse(), answers: { 'q-root': answer } };
}

function unwrapDecision(result: Result<Decision>): Decision {
  if (!result.ok) throw new Error(`unexpected error: ${result.code}: ${result.detail}`);
  return result.value;
}

describe('RulesProvider (deterministic baseline)', () => {
  it('answers with a valid degenerate distribution and stays deterministic', async () => {
    const provider = new RulesProvider();
    const first = unwrapDecision(await provider.decide(request()));
    expect(first.provider).toBe('rules');
    expect(first.error).toBeNull();
    const answer = first.answers[0];
    expect(answer?.selectedId).toBe('cat-invoices');
    expect(answer?.probabilities['cat-invoices']).toBe(1);
    const check = Object.values(answer?.probabilities ?? {}).reduce((a, b) => a + b, 0);
    expect(check).toBeCloseTo(1, 6);
    expect(first.evidenceHash).toBe(request().evidence.stateHash);

    const second = unwrapDecision(await provider.decide(request()));
    expect(second.answers).toEqual(first.answers);
    await provider.close();
  });

  it('selects unknown when no rule matches the evidence', async () => {
    const provider = new RulesProvider();
    const odd = unwrapDecision(
      await provider.decide(
        request('unrelated gibberish content with no rule match', 'zzyyx-blob-7734.bin'),
      ),
    );
    expect(odd.answers[0]?.selectedId).toBe('unknown');
    await provider.close();
  });

  it('health reports an in-process manifest', async () => {
    const provider = new RulesProvider();
    const health = await provider.health();
    expect(health.ok).toBe(true);
    if (health.ok) {
      expect(health.value.provider).toBe('rules');
      expect(health.value.endpoint).toBeNull();
      expect(health.value.modelRevision).toBeTruthy();
    }
    await provider.close();
  });
});

describe('ClefProvider (typed SystemOne endpoint)', () => {
  const okTransport = (body: Record<string, unknown> = systemOneResponse()): ClefTransport => ({
    post: async () => ({ status: 200, body }),
  });

  it('accepts a correct SystemOne response into a validated decision', async () => {
    const provider = new ClefProvider({ endpoint: 'http://127.0.0.1:11434' }, { transport: okTransport() });
    const decision = unwrapDecision(await provider.decide(request()));
    expect(decision.provider).toBe('clef');
    expect(decision.error).toBeNull();
    expect(decision.answers[0]?.selectedId).toBe('cat-invoices');
    expect(decision.answers[0]?.probabilities['cat-invoices']).toBeGreaterThan(0.5);
    expect(decision.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(decision.evidenceHash).toBe(request().evidence.stateHash);
    await provider.close();
  });

  it('rejects a distribution with a missing option ID (no executable proposal)', async () => {
    const provider = new ClefProvider(
      { endpoint: 'http://127.0.0.1:11434' },
      {
        transport: okTransport(
          withAnswer({
            type: 'choice',
            choice: 'cat-invoices',
            probabilities: { 'cat-invoices': 1, 'cat-media': 0 },
            confidence: 1,
          }),
        ),
      },
    );
    const result = await provider.decide(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_DECISION');
    await provider.close();
  });

  it('rejects a probability sum of 0.8', async () => {
    const provider = new ClefProvider(
      { endpoint: 'http://127.0.0.1:11434' },
      {
        transport: okTransport(
          withAnswer({
            type: 'choice',
            choice: 'cat-invoices',
            probabilities: { 'cat-invoices': 0.5, 'cat-media': 0.2, unknown: 0.1 },
            confidence: 0.5,
          }),
        ),
      },
    );
    const result = await provider.decide(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_DECISION');
    await provider.close();
  });

  it('rejects NaN probabilities', async () => {
    const provider = new ClefProvider(
      { endpoint: 'http://127.0.0.1:11434' },
      {
        transport: okTransport(
          withAnswer({
            type: 'choice',
            choice: 'cat-invoices',
            probabilities: { 'cat-invoices': Number.NaN, 'cat-media': 0, unknown: 1 },
            confidence: 0.5,
          }),
        ),
      },
    );
    const result = await provider.decide(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_DECISION');
    await provider.close();
  });

  it('rejects a selected ID that is not a maximum-probability option', async () => {
    const provider = new ClefProvider(
      { endpoint: 'http://127.0.0.1:11434' },
      {
        transport: okTransport(
          withAnswer({
            type: 'choice',
            choice: 'cat-media',
            probabilities: { 'cat-invoices': 0.82, 'cat-media': 0.08, unknown: 0.1 },
            confidence: 0.82,
          }),
        ),
      },
    );
    const result = await provider.decide(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_DECISION');
    await provider.close();
  });

  it('rejects unexpected response fields rather than exposing provider output', async () => {
    const provider = new ClefProvider(
      { endpoint: 'http://127.0.0.1:11434' },
      { transport: okTransport(systemOneResponse({ suggestedPath: '/usr/bin/rm -rf' })) },
    );
    const result = await provider.decide(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_DECISION');
    if (!result.ok) expect(result.detail).toContain('suggestedPath');
    await provider.close();
  });

  it('rejects an answer for the wrong question id, a non-choice type and unexpected answer fields', async () => {
    const wrongQuestion = new ClefProvider(
      { endpoint: 'http://127.0.0.1:11434' },
      { transport: okTransport({ ...systemOneResponse(), answers: { 'q-other': { type: 'choice', choice: 'cat-invoices', probabilities: { 'cat-invoices': 1 }, confidence: 1 } } }) },
    );
    const wrongResult = await wrongQuestion.decide(request());
    expect(wrongResult.ok).toBe(false);
    if (!wrongResult.ok) expect(wrongResult.detail).toContain('q-root');
    await wrongQuestion.close();

    const scored = new ClefProvider(
      { endpoint: 'http://127.0.0.1:11434' },
      { transport: okTransport(withAnswer({ type: 'score', choice: 'cat-invoices', probabilities: { 'cat-invoices': 1 }, confidence: 1 })) },
    );
    const scoredResult = await scored.decide(request());
    expect(scoredResult.ok).toBe(false);
    if (!scoredResult.ok) expect(scoredResult.code).toBe('INVALID_DECISION');
    await scored.close();

    const sneaky = new ClefProvider(
      { endpoint: 'http://127.0.0.1:11434' },
      { transport: okTransport(withAnswer({ type: 'choice', choice: 'cat-invoices', probabilities: { 'cat-invoices': 1 }, confidence: 1, suggestedPath: '/usr/bin/rm -rf' })) },
    );
    const sneakyResult = await sneaky.decide(request());
    expect(sneakyResult.ok).toBe(false);
    if (!sneakyResult.ok) expect(sneakyResult.detail).toContain('suggestedPath');
    await sneaky.close();
  });

  it('enforces the per-item deadline on a hanging endpoint', async () => {
    const hanging: ClefTransport = {
      post: () => new Promise(() => {}),
    };
    const provider = new ClefProvider(
      { endpoint: 'http://127.0.0.1:11434' },
      { transport: hanging, deadlineMs: 80 },
    );
    const result = await provider.decide(request());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PROVIDER_FAILED');
      expect(result.detail).toMatch(/deadline|timeout/i);
    }
    await provider.close();
  }, 10_000);

  it('retries once for a transient failure and records the failure permanently otherwise', async () => {
    let calls = 0;
    const flaky: ClefTransport = {
      post: async () => {
        calls += 1;
        if (calls === 1) throw new Error('ECONNRESET transient');
        return { status: 200, body: systemOneResponse() };
      },
    };
    const provider = new ClefProvider({ endpoint: 'http://127.0.0.1:11434' }, { transport: flaky });
    const decision = unwrapDecision(await provider.decide(request()));
    expect(decision.answers[0]?.selectedId).toBe('cat-invoices');
    expect(calls).toBe(2);
    await provider.close();

    let permanentCalls = 0;
    const dead: ClefTransport = {
      post: async () => {
        permanentCalls += 1;
        throw new Error('ECONNREFUSED');
      },
    };
    const broken = new ClefProvider({ endpoint: 'http://127.0.0.1:11434' }, { transport: dead });
    const failed = await broken.decide(request());
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.code).toBe('PROVIDER_FAILED');
    expect(permanentCalls).toBe(2); // one retry only
    await broken.close();
  });

  it('refuses a non-loopback endpoint even when configured (privacy boundary)', async () => {
    const provider = new ClefProvider(
      { endpoint: 'http://clef.example.com' },
      { transport: okTransport() },
    );
    const health = await provider.health();
    expect(health.ok).toBe(false);
    if (!health.ok) {
      expect(health.code).toBe('PROVIDER_FAILED');
      expect(health.detail).toMatch(/loopback/i);
    }
    const decision = await provider.decide(request());
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.detail).toMatch(/loopback/i);
    await provider.close();
  });

  it('health verifies a typed synthetic response and reports blocked endpoints', async () => {
    // The healthy transport answers whatever synthetic question it is asked,
    // in the real SystemOne wire format.
    const typedTransport: ClefTransport = {
      post: async (_url, body) => {
        const questions = (body as { questions: Record<string, { criteria: Record<string, string> }> }).questions;
        const entry = Object.entries(questions)[0];
        const answers: Record<string, unknown> = {};
        if (entry !== undefined) {
          const [questionId, question] = entry;
          const optionIds = Object.keys(question.criteria);
          const probabilities: Record<string, number> = {};
          for (const optionId of optionIds) {
            probabilities[optionId] = optionId === optionIds[0] ? 1 : 0;
          }
          answers[questionId] = {
            type: 'choice',
            choice: optionIds[0],
            probabilities,
            confidence: 1,
          };
        }
        return { status: 200, body: { model: 'fixture-clef', answers, usage: { input_tokens: 42 } } };
      },
    };
    const healthy = new ClefProvider(
      { endpoint: 'http://127.0.0.1:11434' },
      { transport: typedTransport },
    );
    const ok = await healthy.health();
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.endpoint).toContain('127.0.0.1:11434');
      expect(ok.value.endpoint).toContain('/v1/systemone');
    }
    await healthy.close();

    const notFound: ClefTransport = {
      post: async () => ({ status: 404, body: { error: 'unknown endpoint' } }),
    };
    const chat = new ClefProvider({ endpoint: 'http://127.0.0.1:11434' }, { transport: notFound });
    const blocked = await chat.health();
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.code).toBe('PROVIDER_FAILED');
      expect(blocked.detail).toMatch(/404|systemone/i);
    }
    await chat.close();
  });
});

describe('LayaProvider (blocked without a local checkpoint)', () => {
  it('reports blocked health and failed decisions when no checkpoint exists', async () => {
    const provider = new LayaProvider({});
    const health = await provider.health();
    expect(health.ok).toBe(false);
    if (!health.ok) expect(health.detail).toMatch(/checkpoint|blocked|unavailable|modelDir/i);

    const decision = await provider.decide(request());
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.code).toBe('PROVIDER_FAILED');
    await provider.close();
  });

  /**
   * Real-model smoke (plan Task 4 step: "Run optional real-model smoke tests
   * on synthetic material and record pass/blocked status separately"). Runs
   * only when the pinned bundle directory exists on this machine; the
   * synthetic fixture carries no ground-truth claim.
   */
  const LAYA_BUNDLE = '/home/asoni/.cache/receptron-laya/receptron--laya-onnx/main';
  const layaAvailable = existsSync(join(LAYA_BUNDLE, 'laya.onnx'));
  const describeRealModel = layaAvailable ? describe : describe.skip;

  describeRealModel('LayaProvider (real local ONNX model, opt-in)', () => {
    it('answers the canonical question through the validated contract', async () => {
      const provider = new LayaProvider({ modelDir: LAYA_BUNDLE });
      const health = await provider.health();
      expect(health.ok).toBe(true);
      if (health.ok) {
        expect(health.value.questionTokenLimit).toBe(192);
        expect(health.value.inputTokenLimit).toBe(512);
      }

      const canonical = request('synthetic fixture invoice for hosting text');
      const decision = await provider.decide(canonical);
      expect(decision.ok).toBe(true);
      if (decision.ok) {
        const answer = decision.value.answers[0];
        expect(answer).toBeDefined();
        const total = Object.values(answer?.probabilities ?? {}).reduce((a, b) => a + b, 0);
        expect(total).toBeGreaterThan(0.99);
        expect(decision.value.evidenceHash).toBe(canonical.evidence.stateHash);
        expect(decision.value.schemaHash).toBe(canonical.schemaHash);
      }
      await provider.close();
    }, 120_000);
  });
});

describe('JevProvider (cloud reference, consent required)', () => {
  it('requires explicit dataset cloud consent before any request', async () => {
    const provider = new JevProvider({});
    const decision = await provider.decide(request());
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.code).toBe('UNAUTHORISED');
      expect(decision.detail).toMatch(/consent/i);
    }
    const health = await provider.health();
    expect(health.ok).toBe(false);
    if (!health.ok) expect(health.code).toBe('UNAUTHORISED');
    await provider.close();
  });

  it('refuses a non-loopback endpoint even when configured (privacy boundary)', async () => {
    const provider = new JevProvider(
      { consentReference: 'fixture-consent', endpoint: 'http://cloud.jev.example' },
      { transport: { post: async () => ({ status: 200, body: systemOneResponse() }) } },
    );
    const decision = await provider.decide(request());
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.detail).toMatch(/loopback/i);
    await provider.close();
  });

  it('retries once on transient failure exactly like clef', async () => {
    let calls = 0;
    const flaky: ClefTransport = {
      post: async () => {
        calls += 1;
        if (calls === 1) throw new Error('ECONNRESET transient');
        return { status: 200, body: systemOneResponse() };
      },
    };
    const provider = new JevProvider(
      { consentReference: 'fixture-consent', endpoint: 'http://127.0.0.1:9/jev-fixture' },
      { transport: flaky },
    );
    const decision = unwrapDecision(await provider.decide(request()));
    expect(decision.provider).toBe('jev');
    expect(calls).toBe(2);
    await provider.close();

    let deadCalls = 0;
    const dead: ClefTransport = {
      post: async () => {
        deadCalls += 1;
        throw new Error('ECONNREFUSED');
      },
    };
    const broken = new JevProvider(
      { consentReference: 'fixture-consent', endpoint: 'http://127.0.0.1:9/jev-fixture' },
      { transport: dead },
    );
    const failed = await broken.decide(request());
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.code).toBe('PROVIDER_FAILED');
    expect(deadCalls).toBe(2);
    await broken.close();
  });

  it('probes only after consent is recorded, using the injected transport', async () => {
    let posted = 0;
    const transport: ClefTransport = {
      post: async () => {
        posted += 1;
        return { status: 200, body: systemOneResponse() };
      },
    };
    const provider = new JevProvider(
      {
        consentReference: 'consent-2026-10-07-user-approved-fixture',
        endpoint: 'http://127.0.0.1:9/jev-fixture',
      },
      { transport },
    );
    const decision = unwrapDecision(await provider.decide(request()));
    expect(decision.provider).toBe('jev');
    expect(posted).toBe(1);
    await provider.close();
  });
});

describe('probeProviders (doctor)', () => {
  it('reports per-provider ok/blocked status without substitutions', async () => {
    const notFound: ClefTransport = {
      post: async () => ({ status: 404, body: { error: 'not found' } }),
    };
    const health = await probeProviders(
      { clef: { endpoint: 'http://127.0.0.1:11434' } },
      { transport: notFound },
    );
    const byProvider = new Map(health.map((h) => [h.provider, h]));

    expect(byProvider.get('rules')?.status).toBe('ok');
    expect(byProvider.get('laya')?.status).toBe('blocked');
    expect(byProvider.get('clef')?.status).toBe('blocked');
    if (byProvider.get('clef')?.status === 'blocked') {
      expect(byProvider.get('clef')?.detail).toMatch(/404|systemone/i);
    }
    expect(byProvider.get('jev')?.status).toBe('blocked');
    expect(byProvider.get('jev')?.detail).toMatch(/consent|disabled/i);
  });

  it('reports a healthy clef endpoint as ok', async () => {
    // A "correct SystemOne" simulator: answers whatever question it is asked,
    // in the real wire format (answers keyed by question id).
    const ok: ClefTransport = {
      post: async (_url, body) => {
        const questions = (body as { questions: Record<string, { criteria: Record<string, string> }> }).questions;
        const entry = Object.entries(questions)[0];
        const answers: Record<string, unknown> = {};
        if (entry !== undefined) {
          const [questionId, question] = entry;
          const optionIds = Object.keys(question.criteria);
          const probabilities: Record<string, number> = {};
          for (const optionId of optionIds) {
            probabilities[optionId] = optionId === optionIds[0] ? 1 : 0;
          }
          answers[questionId] = {
            type: 'choice',
            choice: optionIds[0],
            probabilities,
            confidence: 1,
          };
        }
        return { status: 200, body: { model: 'fixture-clef', answers, usage: { input_tokens: 42 } } };
      },
    };
    const health = await probeProviders(
      {
        clef: { endpoint: 'http://127.0.0.1:11434' },
        jev: { consentReference: 'fixture-consent', endpoint: 'http://127.0.0.1:9/jev-fixture' },
      },
      { transport: ok },
    );
    const byProvider = new Map<string, ProviderHealth>(health.map((h) => [h.provider, h]));
    expect(byProvider.get('clef')?.status).toBe('ok');
    expect(byProvider.get('jev')?.status).toBe('ok');
  });
});
