/**
 * Jev cloud reference provider (plan Task 4, LLD §3) — DEFERRED (spec review
 * R14). No verified Jev integration contract exists for this application: the
 * `/v1/choice` request shape and the Clef-compatible response format are
 * implementation assumptions, and a subscription that exposes a model does
 * not establish a usable standalone API. The adapter therefore stays
 * disabled/deferred until a verified contract, authentication and a
 * dataset-scoped consent boundary are recorded, and it never widens cloud
 * access on its own. The guarded path below exists only for that future
 * verified integration and is inert unless `verifiedContract` is explicitly
 * configured.
 */
import { randomUUID } from 'node:crypto';
import {
  err,
  ok,
  validateChoiceAnswer,
  type Decision,
  type DecisionProvider,
  type DecisionRequest,
  type ProviderManifest,
  type Result,
} from '../../domain/contracts.js';
import { parseSystemOneAnswer, buildSystemOneRequest, type ClefTransport } from './clef.js';

export const JEV_CHOICE_PATH = '/v1/choice';

export interface JevConfig {
  /**
   * Authorised dataset/subset boundary: which dataset and split the consent
   * covers. A bare reference string is not a consent boundary.
   */
  consentScope?: { datasetId: string; subset: string; recordedAt: string };
  /** Explicitly configured endpoint; never guessed. */
  endpoint?: string;
  /**
   * Set only when a verified Jev API contract (request/response shapes,
   * authentication, dataset-scoped consent) has been recorded. Absent means
   * the provider reports deferred, whatever else is configured.
   */
  verifiedContract?: { contractRevision: string; verifiedAt: string };
}

export interface JevDeps {
  transport?: ClefTransport;
  deadlineMs?: number;
}

export class JevProvider implements DecisionProvider {
  readonly providerId = 'jev' as const;
  private readonly config: JevConfig;
  private readonly transport: ClefTransport | undefined;
  private readonly deadlineMs: number;

  constructor(config: JevConfig = {}, deps: JevDeps = {}) {
    this.config = config;
    this.transport = deps.transport;
    this.deadlineMs = deps.deadlineMs ?? 120_000;
  }

  /**
   * The deferral that answers every call until a verified contract exists.
   * This is the honest state of the adapter today (spec review R14).
   */
  private deferred(): Result<never> {
    return err(
      'UNAUTHORISED',
      'Jev is deferred: no verified provider API contract, authentication or ' +
        'dataset-scoped consent boundary is recorded for this application; ' +
        'the adapter stays disabled rather than assuming an API shape',
    );
  }

  private guard(): Result<{ url: string; transport: ClefTransport }> {
    if (this.config.verifiedContract === undefined) {
      return this.deferred();
    }
    if (this.config.consentScope === undefined) {
      return err(
        'UNAUTHORISED',
        'Jev requires an authorised dataset/subset consent scope; none recorded, adapter disabled',
      );
    }
    if (this.config.endpoint === undefined || this.transport === undefined) {
      return err(
        'UNAUTHORISED',
        'Jev endpoint/transport not explicitly configured; disabled rather than guessed',
      );
    }
    // A hosted endpoint is legitimate once a verified contract exists; the
    // local-only guard is not reused for it (spec review R14).
    return ok({
      url: `${this.config.endpoint.replace(/\/+$/, '')}${JEV_CHOICE_PATH}`,
      transport: this.transport,
    });
  }

  async health(): Promise<Result<ProviderManifest>> {
    const guard = this.guard();
    if (!guard.ok) return guard;
    const probeQuestion = {
      id: 'q-synthetic-health',
      instruction: 'Synthetic health probe: select the category of this fixture document.',
      options: [
        { id: 'cat-docs', description: 'Documents' },
        { id: 'unknown', description: 'Unknown or insufficient evidence' },
      ],
    };
    try {
      const response = await guard.value.transport.post(
        guard.value.url,
        buildSystemOneRequest(
          {
            basename: 'synthetic-jev-fixture.txt',
            detectedFormat: 'text',
            sizeBytes: 10,
            compactText: 'synthetic fixture for health probe',
          },
          probeQuestion,
        ),
        { timeoutMs: this.deadlineMs },
      );
      if (response.status !== 200) {
        return err('PROVIDER_FAILED', `endpoint returned HTTP ${response.status} for ${JEV_CHOICE_PATH}`);
      }
      const answer = parseSystemOneAnswer(response.body, probeQuestion.id);
      if (!answer.ok) return err('PROVIDER_FAILED', `endpoint did not return a typed answer: ${answer.detail}`);
      const validated = validateChoiceAnswer(answer.value, probeQuestion);
      if (!validated.ok) {
        return err('PROVIDER_FAILED', `endpoint's synthetic answer is not a valid distribution: ${validated.detail}`);
      }
      return ok({
        provider: 'jev',
        modelRevision: answer.value.modelRevision ?? 'unreported-by-endpoint',
        runtimeRevision: 'jev-http',
        tokenizerRevision: 'endpoint-side',
        questionTokenLimit: null,
        inputTokenLimit: null,
        endpoint: guard.value.url,
      });
    } catch (error) {
      return err('PROVIDER_FAILED', `jev health probe failed: ${(error as Error).message}`);
    }
  }

  async decide(request: DecisionRequest): Promise<Result<Decision>> {
    const guard = this.guard();
    if (!guard.ok) return guard;
    const question = request.questions[0];
    if (question === undefined) {
      return err('INVALID_DECISION', 'decision request contains no question');
    }
    const startedAt = Date.now();

    // Same contract as Clef: at most one retry for a transient failure;
    // HTTP error statuses are not retried.
    let attempt = 0;
    let lastError = 'unavailable';
    while (attempt < 2) {
      try {
        const response = await guard.value.transport.post(
          guard.value.url,
          buildSystemOneRequest(request.evidence.state, question),
          { timeoutMs: this.deadlineMs },
        );
        if (response.status !== 200) {
          return err('PROVIDER_FAILED', `endpoint returned HTTP ${response.status} for ${JEV_CHOICE_PATH}`);
        }
        const answer = parseSystemOneAnswer(response.body, question.id);
        if (!answer.ok) return answer;
        const validated = validateChoiceAnswer(answer.value, question);
        if (!validated.ok) {
          return err('INVALID_DECISION', `jev returned an invalid distribution: ${validated.detail}`);
        }
        const { modelRevision, ...choiceAnswer } = answer.value;
        return ok({
          id: `decision-${randomUUID()}`,
          itemId: request.evidence.itemId,
          provider: 'jev',
          modelRevision: modelRevision ?? 'unreported-by-endpoint',
          runtimeRevision: 'jev-http',
          evidenceHash: request.evidence.stateHash,
          schemaHash: request.schemaHash,
          answers: [choiceAnswer],
          elapsedMs: Date.now() - startedAt,
          tokenCounts: {},
          error: null,
        });
      } catch (error) {
        lastError = (error as Error).message;
        attempt += 1;
      }
    }
    return err('PROVIDER_FAILED', `jev decide failed after one retry: ${lastError}`);
  }

  async close(): Promise<void> {}
}
