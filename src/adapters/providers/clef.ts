/**
 * Clef-flash typed decision provider (plan Task 4, LLD §3): POSTs to an
 * explicitly configured loopback SystemOne endpoint and validates typed
 * responses. Health is probed with a synthetic invoice/category fixture
 * BEFORE any private evidence is loaded. A chat-only or missing endpoint is
 * recorded as blocked — never substituted with a chat completion.
 *
 * Wire format (llama.cpp SystemOne API, ggml-org PR 29831, verified against
 * the built server):
 *   request  { state, questions: { [id]: { type: 'choice', instructions,
 *              criteria: { optionId: description } } } }
 *   response { model, answers: { [id]: { type, choice, probabilities,
 *              confidence } }, usage: { input_tokens } }
 * The canonical question is translated to this syntax here; the canonical
 * answer is validated against the same ChoiceAnswer contract as every other
 * provider before it can become a decision.
 */
import { randomUUID } from 'node:crypto';
import {
  err,
  ok,
  validateChoiceAnswer,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type Decision,
  type DecisionProvider,
  type DecisionRequest,
  type Id,
  type ProviderId,
  type ProviderManifest,
  type Result,
} from '../../domain/contracts.js';

export const SYSTEMONE_PATH = '/v1/systemone';

/** Injectable transport seam; the default uses fetch with a timeout signal. */
export interface ClefTransport {
  post(url: string, body: unknown, options: { timeoutMs: number }): Promise<{ status: number; body: unknown }>;
}

export interface ClefConfig {
  endpoint: string;
}

export interface ClefDeps {
  transport?: ClefTransport;
  /** Per-item deadline; 120 seconds by default (PRD §6). */
  deadlineMs?: number;
}

class DeadlineError extends Error {
  constructor(ms: number) {
    super(`deadline of ${ms}ms exceeded`);
  }
}

/** A canonical answer parsed from a typed SystemOne response. */
export interface SystemOneAnswer extends ChoiceAnswer {
  modelRevision?: string;
  tokenCounts?: Record<string, number>;
}

const ALLOWED_TOP_LEVEL_KEYS = new Set(['model', 'answers', 'usage']);
const ALLOWED_ANSWER_KEYS = new Set(['type', 'choice', 'probabilities', 'confidence']);

/**
 * Parses the typed SystemOne response for one canonical question. Unexpected
 * fields are rejected rather than ignored: provider output is never exposed
 * as anything but category selections.
 */
export function parseSystemOneAnswer(
  body: unknown,
  questionId: Id,
): Result<SystemOneAnswer> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return err('INVALID_DECISION', 'SystemOne response is not an object');
  }
  const response = body as Record<string, unknown>;
  for (const key of Object.keys(response)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      return err(
        'INVALID_DECISION',
        `SystemOne response contains unexpected field ${JSON.stringify(key)}; provider output is not exposed as actions`,
      );
    }
  }
  if (typeof response.answers !== 'object' || response.answers === null || Array.isArray(response.answers)) {
    return err('INVALID_DECISION', 'SystemOne response answers is not an object');
  }
  const answers = response.answers as Record<string, unknown>;
  const answer = answers[questionId];
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    return err('INVALID_DECISION', `SystemOne response has no answer for question ${JSON.stringify(questionId)}`);
  }
  const record = answer as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_ANSWER_KEYS.has(key)) {
      return err(
        'INVALID_DECISION',
        `SystemOne answer contains unexpected field ${JSON.stringify(key)}; provider output is not exposed as actions`,
      );
    }
  }
  if (record.type !== 'choice') {
    return err('INVALID_DECISION', `SystemOne answer type ${JSON.stringify(record.type)} is not a supported choice answer`);
  }
  if (typeof record.choice !== 'string') {
    return err('INVALID_DECISION', 'SystemOne answer choice is not a string');
  }
  if (
    typeof record.probabilities !== 'object' ||
    record.probabilities === null ||
    Array.isArray(record.probabilities)
  ) {
    return err('INVALID_DECISION', 'SystemOne answer probabilities is not a record');
  }
  if (
    record.confidence !== undefined &&
    record.confidence !== null &&
    typeof record.confidence !== 'number'
  ) {
    return err('INVALID_DECISION', 'SystemOne answer confidence is not a number');
  }
  const modelRevision = typeof response.model === 'string' ? response.model : undefined;
  const tokenCounts: Record<string, number> = {};
  const usage = response.usage as Record<string, unknown> | undefined;
  if (typeof usage === 'object' && usage !== null && typeof usage.input_tokens === 'number') {
    tokenCounts.input = usage.input_tokens;
  }
  return ok({
    questionId,
    selectedId: record.choice,
    probabilities: record.probabilities as Record<string, number>,
    providerConfidence: (record.confidence as number | null | undefined) ?? null,
    ...(modelRevision !== undefined ? { modelRevision } : {}),
    ...(Object.keys(tokenCounts).length > 0 ? { tokenCounts } : {}),
  });
}

/** Builds the SystemOne request body for one canonical question. */
export function buildSystemOneRequest(
  evidenceState: Record<string, unknown>,
  question: ChoiceQuestion,
): Record<string, unknown> {
  const criteria: Record<string, string> = {};
  for (const option of question.options) {
    criteria[option.id] = option.description;
  }
  return {
    state: evidenceState,
    questions: {
      [question.id]: {
        type: 'choice',
        instructions: question.instruction,
        criteria,
      },
    },
  };
}

/**
 * Privacy boundary (LLD §3 "explicitly configured loopback endpoint",
 * AGENTS.md rule 9): provider endpoints must be loopback. Anything that
 * would send local evidence off-machine is refused, never attempted.
 */
export function assertLoopbackEndpoint(endpoint: string): { ok: true } | { ok: false; detail: string } {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return { ok: false, detail: `endpoint ${JSON.stringify(endpoint)} is not a valid URL` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, detail: `endpoint protocol ${parsed.protocol} is not http(s)` };
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback =
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host === '::1' ||
    /^127(\.\d{1,3}){3}$/.test(host);
  if (!isLoopback) {
    return {
      ok: false,
      detail: `endpoint ${JSON.stringify(endpoint)} is not loopback; refusing to send local evidence off-machine`,
    };
  }
  return { ok: true };
}

function fetchTransport(): ClefTransport {
  return {
    async post(url, body, options) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      let parsed: unknown = null;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed };
    },
  };
}

export class ClefProvider implements DecisionProvider {
  readonly providerId: ProviderId = 'clef';
  private readonly endpoint: string;
  private readonly transport: ClefTransport;
  private readonly deadlineMs: number;

  constructor(config: ClefConfig, deps: ClefDeps = {}) {
    this.endpoint = config.endpoint.replace(/\/+$/, '');
    this.transport = deps.transport ?? fetchTransport();
    this.deadlineMs = deps.deadlineMs ?? 120_000;
  }

  private withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new DeadlineError(ms)), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private url(): string {
    return `${this.endpoint}${SYSTEMONE_PATH}`;
  }

  /** Returns a failed Result when the endpoint is not loopback. */
  private guardEndpoint(): Result<void> {
    const checked = assertLoopbackEndpoint(this.endpoint);
    if (!checked.ok) return err('PROVIDER_FAILED', checked.detail);
    return ok(undefined);
  }

  async health(): Promise<Result<ProviderManifest>> {
    const guard = this.guardEndpoint();
    if (!guard.ok) return guard;
    const probeQuestion: ChoiceQuestion = {
      id: 'q-synthetic-health',
      instruction: 'Synthetic health probe: select the category of this fixture invoice.',
      options: [
        { id: 'cat-invoices', description: 'Invoice and billing documents' },
        { id: 'cat-media', description: 'Photos, video and audio' },
        { id: 'unknown', description: 'Unknown or insufficient evidence' },
      ],
    };
    const body = buildSystemOneRequest(
      {
        basename: 'synthetic-invoice-fixture.txt',
        detectedFormat: 'text',
        sizeBytes: 21,
        compactText: 'synthetic fixture invoice for health probe text',
      },
      probeQuestion,
    );
    try {
      const response = await this.withDeadline(
        this.transport.post(this.url(), body, { timeoutMs: this.deadlineMs }),
        this.deadlineMs,
      );
      if (response.status !== 200) {
        return err(
          'PROVIDER_FAILED',
          `endpoint returned HTTP ${response.status} for ${SYSTEMONE_PATH}; typed SystemOne endpoint unavailable (blocked, not substituted)`,
        );
      }
      const answer = parseSystemOneAnswer(response.body, probeQuestion.id);
      if (!answer.ok) {
        return err('PROVIDER_FAILED', `endpoint did not return a typed SystemOne answer: ${answer.detail}`);
      }
      const validated = validateChoiceAnswer(answer.value, probeQuestion);
      if (!validated.ok) {
        return err('PROVIDER_FAILED', `endpoint's synthetic answer is not a valid distribution: ${validated.detail}`);
      }
      return ok({
        provider: 'clef',
        modelRevision: answer.value.modelRevision ?? 'unreported-by-endpoint',
        runtimeRevision: 'llama.cpp systemone-server',
        tokenizerRevision: 'server-side (GGUF tokenizer)',
        // The whole prompt is batched by the model and must fit the server
        // context; the conservative estimator still guards client-side.
        questionTokenLimit: null,
        inputTokenLimit: 4096,
        endpoint: this.url(),
      });
    } catch (error) {
      return err('PROVIDER_FAILED', `clef health probe failed: ${(error as Error).message}`);
    }
  }

  async decide(request: DecisionRequest): Promise<Result<Decision>> {
    const guard = this.guardEndpoint();
    if (!guard.ok) return guard;
    const question = request.questions[0];
    if (question === undefined) {
      return err('INVALID_DECISION', 'decision request contains no question');
    }
    const url = this.url();
    const body = buildSystemOneRequest(request.evidence.state, question);
    const startedAt = Date.now();

    let attempt = 0;
    let lastError = 'unavailable';
    // At most one retry for a transient failure (PRD §6); deadline failures
    // and HTTP error statuses are not retried.
    while (attempt < 2) {
      const remaining = this.deadlineMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        return err('PROVIDER_FAILED', `clef decide exceeded the ${this.deadlineMs}ms deadline`);
      }
      try {
        const response = await this.withDeadline(
          this.transport.post(url, body, { timeoutMs: remaining }),
          remaining,
        );
        if (response.status !== 200) {
          return err(
            'PROVIDER_FAILED',
            `endpoint returned HTTP ${response.status} for ${SYSTEMONE_PATH}; provider blocked, not substituted`,
          );
        }
        const answer = parseSystemOneAnswer(response.body, question.id);
        if (!answer.ok) return answer;
        const validated = validateChoiceAnswer(answer.value, question);
        if (!validated.ok) {
          return err('INVALID_DECISION', `clef returned an invalid distribution: ${validated.detail}`);
        }
        const { modelRevision, tokenCounts, ...choiceAnswer } = answer.value;
        return ok({
          id: `decision-${randomUUID()}`,
          itemId: request.evidence.itemId,
          provider: 'clef',
          modelRevision: modelRevision ?? 'unreported-by-endpoint',
          runtimeRevision: 'llama.cpp systemone-server',
          evidenceHash: request.evidence.stateHash,
          schemaHash: request.schemaHash,
          answers: [choiceAnswer],
          elapsedMs: Date.now() - startedAt,
          tokenCounts: tokenCounts ?? {},
          error: null,
        });
      } catch (error) {
        if (error instanceof DeadlineError) {
          return err('PROVIDER_FAILED', `clef decide exceeded the ${this.deadlineMs}ms deadline`);
        }
        lastError = (error as Error).message;
        attempt += 1;
      }
    }
    return err('PROVIDER_FAILED', `clef endpoint unreachable after one retry: ${lastError}`);
  }

  async close(): Promise<void> {}
}
