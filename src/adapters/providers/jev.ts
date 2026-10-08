/**
 * Jev cloud reference provider (plan Task 4, LLD §3). Disabled unless the
 * dataset's explicit cloud consent is recorded; its endpoint is configured
 * explicitly, never guessed from documentation. With consent and an explicit
 * endpoint it probes a typed choice primitive and validates answers through
 * the same contract as every local provider.
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
import { parseSystemOneAnswer, type ClefTransport } from './clef.js';

export const JEV_CHOICE_PATH = '/v1/choice';

export interface JevConfig {
  /** Recorded dataset cloud consent reference; absent means disabled. */
  consentReference?: string;
  /** Explicitly configured endpoint; never guessed. */
  endpoint?: string;
}

export interface JevDeps {
  transport?: ClefTransport;
  deadlineMs?: number;
}

export class JevProvider implements DecisionProvider {
  private readonly config: JevConfig;
  private readonly transport: ClefTransport | undefined;
  private readonly deadlineMs: number;

  constructor(config: JevConfig = {}, deps: JevDeps = {}) {
    this.config = config;
    this.transport = deps.transport;
    this.deadlineMs = deps.deadlineMs ?? 120_000;
  }

  private guard(): Result<{ url: string; transport: ClefTransport }> {
    if (this.config.consentReference === undefined) {
      return err(
        'UNAUTHORISED',
        'Jev requires explicit dataset cloud consent; none recorded, adapter disabled',
      );
    }
    if (this.config.endpoint === undefined || this.transport === undefined) {
      return err(
        'UNAUTHORISED',
        'Jev endpoint/transport not explicitly configured; disabled rather than guessed',
      );
    }
    return ok({ url: `${this.config.endpoint.replace(/\/+$/, '')}${JEV_CHOICE_PATH}`, transport: this.transport });
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
      const response = await guard.value.transport.post(guard.value.url, {
        profile: 'metadata',
        evidence: {
          basename: 'synthetic-jev-fixture.txt',
          detectedFormat: 'text',
          sizeBytes: 10,
          compactText: 'synthetic fixture for health probe',
        },
        question: probeQuestion,
        consentReference: this.config.consentReference,
      }, { timeoutMs: this.deadlineMs });
      if (response.status !== 200) {
        return err('PROVIDER_FAILED', `endpoint returned HTTP ${response.status} for ${JEV_CHOICE_PATH}`);
      }
      const answer = parseSystemOneAnswer(response.body);
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
    try {
      const response = await guard.value.transport.post(
        guard.value.url,
        {
          profile: request.evidence.profile,
          evidence: request.evidence.state,
          question,
          taxonomyRevision: request.taxonomyRevision,
          consentReference: this.config.consentReference,
        },
        { timeoutMs: this.deadlineMs },
      );
      if (response.status !== 200) {
        return err('PROVIDER_FAILED', `endpoint returned HTTP ${response.status} for ${JEV_CHOICE_PATH}`);
      }
      const answer = parseSystemOneAnswer(response.body);
      if (!answer.ok) return answer;
      const validated = validateChoiceAnswer(answer.value, question);
      if (!validated.ok) {
        return err('INVALID_DECISION', `jev returned an invalid distribution: ${validated.detail}`);
      }
      const { modelRevision, ...choiceAnswer } = answer.value;
      return ok({
        id: `decision-${randomUUID()}`,
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
      return err('PROVIDER_FAILED', `jev decide failed: ${(error as Error).message}`);
    }
  }

  async close(): Promise<void> {}
}
