/**
 * Clef-flash typed decision provider (plan Task 4, LLD §3): POSTs to an
 * explicitly configured loopback SystemOne endpoint and validates typed
 * responses. Health is probed with a synthetic invoice/category fixture
 * BEFORE any private evidence is loaded. A chat-only or missing endpoint is
 * recorded as blocked — never substituted with a chat completion.
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

const ALLOWED_RESPONSE_KEYS = new Set([
  'questionId',
  'selectedId',
  'probabilities',
  'providerConfidence',
  'modelRevision',
]);

class DeadlineError extends Error {
  constructor(ms: number) {
    super(`deadline of ${ms}ms exceeded`);
  }
}

/** Response shape: exactly the typed answer fields; anything else is rejected. */
export interface SystemOneAnswer extends ChoiceAnswer {
  modelRevision?: string;
}

export function parseSystemOneAnswer(body: unknown): Result<SystemOneAnswer> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return err('INVALID_DECISION', 'SystemOne response is not an object');
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_RESPONSE_KEYS.has(key)) {
      return err(
        'INVALID_DECISION',
        `SystemOne response contains unexpected field ${JSON.stringify(key)}; provider output is not exposed as actions`,
      );
    }
  }
  if (typeof record.questionId !== 'string' || typeof record.selectedId !== 'string') {
    return err('INVALID_DECISION', 'SystemOne response is missing questionId or selectedId');
  }
  if (
    typeof record.probabilities !== 'object' ||
    record.probabilities === null ||
    Array.isArray(record.probabilities)
  ) {
    return err('INVALID_DECISION', 'SystemOne response probabilities is not a record');
  }
  if (
    record.providerConfidence !== undefined &&
    record.providerConfidence !== null &&
    typeof record.providerConfidence !== 'number'
  ) {
    return err('INVALID_DECISION', 'SystemOne response providerConfidence is not a number or null');
  }
  if (record.modelRevision !== undefined && typeof record.modelRevision !== 'string') {
    return err('INVALID_DECISION', 'SystemOne response modelRevision is not a string');
  }
  return ok({
    questionId: record.questionId,
    selectedId: record.selectedId,
    probabilities: record.probabilities as Record<string, number>,
    providerConfidence: (record.providerConfidence as number | null | undefined) ?? null,
    ...(record.modelRevision !== undefined ? { modelRevision: record.modelRevision } : {}),
  });
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

  /** Returns a failed Result when the endpoint is not loopback. */
  private guardEndpoint(): Result<void> {
    const checked = assertLoopbackEndpoint(this.endpoint);
    if (!checked.ok) return err('PROVIDER_FAILED', checked.detail);
    return ok(undefined);
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
    const body = {
      profile: 'metadata',
      evidence: {
        basename: 'synthetic-invoice-fixture.txt',
        detectedFormat: 'text',
        sizeBytes: 21,
        compactText: 'synthetic fixture invoice for health probe text',
      },
      question: probeQuestion,
      taxonomyRevision: 0,
    };
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
      const answer = parseSystemOneAnswer(response.body);
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
        runtimeRevision: 'systemone-http',
        tokenizerRevision: 'endpoint-side',
        questionTokenLimit: null,
        inputTokenLimit: null,
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
    const body = {
      profile: request.evidence.profile,
      evidence: request.evidence.state,
      question,
      taxonomyRevision: request.taxonomyRevision,
    };
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
        const answer = parseSystemOneAnswer(response.body);
        if (!answer.ok) return answer;
        const validated = validateChoiceAnswer(answer.value, question);
        if (!validated.ok) {
          return err('INVALID_DECISION', `clef returned an invalid distribution: ${validated.detail}`);
        }
        const { modelRevision, ...choiceAnswer } = answer.value;
        return ok({
          id: `decision-${randomUUID()}`,
          itemId: request.evidence.itemId,
          provider: 'clef',
          modelRevision: modelRevision ?? 'unreported-by-endpoint',
          runtimeRevision: 'systemone-http',
          evidenceHash: request.evidence.stateHash,
          schemaHash: request.schemaHash,
          answers: [choiceAnswer],
          elapsedMs: Date.now() - startedAt,
          tokenCounts: {},
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
