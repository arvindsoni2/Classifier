/**
 * Deterministic rules baseline provider (plan Task 4). Rules produce a
 * degenerate distribution and are marked deterministic, not statistically
 * calibrated (LLD §3). Output is validated against the same contract as
 * every other provider before it can become a decision.
 */
import { randomUUID } from 'node:crypto';
import {
  ok,
  validateChoiceAnswer,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type Decision,
  type DecisionProvider,
  type DecisionRequest,
  type Evidence,
  type ProviderManifest,
  type Result,
} from '../../domain/contracts.js';

const MODEL_REVISION = 'rules@1.0.0';

function evidenceTokens(evidence: Evidence): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(evidence.state)) {
    if (key === 'compactText' && typeof value === 'string') {
      parts.push(...value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    } else if (typeof value === 'string') {
      parts.push(...value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    }
  }
  return parts;
}

function answerByRules(evidence: Evidence, question: ChoiceQuestion): ChoiceAnswer {
  const tokens = new Set(evidenceTokens(evidence));
  let best: { id: string; score: number } | null = null;
  for (const option of question.options) {
    if (option.id === 'unknown') continue;
    const words = `${option.id} ${option.description}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    // Require the option's label word(s) to appear in the evidence tokens.
    const score = words.filter((word) => word.length > 2 && tokens.has(word)).length;
    if (score > 0 && (best === null || score > best.score)) {
      best = { id: option.id, score };
    }
  }
  const selectedId = best === null ? 'unknown' : best.id;
  const probabilities: Record<string, number> = {};
  for (const option of question.options) {
    probabilities[option.id] = option.id === selectedId ? 1 : 0;
  }
  return {
    questionId: question.id,
    selectedId,
    probabilities,
    providerConfidence: null,
  };
}

export class RulesProvider implements DecisionProvider {
  readonly providerId = 'rules' as const;
  async health(): Promise<Result<ProviderManifest>> {
    return ok({
      provider: 'rules',
      modelRevision: MODEL_REVISION,
      runtimeRevision: process.version,
      tokenizerRevision: 'deterministic (no tokenizer)',
      questionTokenLimit: null,
      inputTokenLimit: null,
      endpoint: null,
    });
  }

  async decide(request: DecisionRequest): Promise<Result<Decision>> {
    const answers: ChoiceAnswer[] = [];
    for (const question of request.questions) {
      const answer = answerByRules(request.evidence, question);
      const validated = validateChoiceAnswer(answer, question);
      if (!validated.ok) {
        return {
          ok: false,
          code: 'INVALID_DECISION',
          detail: `rules produced an invalid distribution: ${validated.detail}`,
        } satisfies Result<Decision>;
      }
      answers.push(answer);
    }
    return ok({
      id: `decision-${randomUUID()}`,
      provider: 'rules',
      modelRevision: MODEL_REVISION,
      runtimeRevision: process.version,
      evidenceHash: request.evidence.stateHash,
      schemaHash: request.schemaHash,
      answers,
      elapsedMs: 0,
      tokenCounts: {},
      error: null,
    });
  }

  async close(): Promise<void> {}
}
