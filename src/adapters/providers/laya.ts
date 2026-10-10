/**
 * Laya local ONNX decision provider (plan Task 4, LLD §3, docs/08 S1).
 *
 * Runs the pinned @receptron/laya package (convaiinnovations/laya via ONNX
 * Runtime) with a modelDir that must be explicitly configured — a provider
 * with no bundle never downloads a model by surprise and reports blocked.
 * The instance is loaded once and reused (one inference at a time).
 */
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { Laya } from '@receptron/laya';
import type { ChoiceQuestion as LayaChoiceQuestion } from '@receptron/laya';
import {
  err,
  ok,
  validateChoiceAnswer,
  type ChoiceQuestion,
  type Decision,
  type DecisionProvider,
  type DecisionRequest,
  type ProviderId,
  type ProviderManifest,
  type Result,
} from '../../domain/contracts.js';

export interface LayaConfig {
  /**
   * Directory holding laya.onnx, laya.onnx.data, laya_config.json and
   * tokenizer/ (the output of the package's export step). Required: no
   * implicit model download.
   */
  modelDir?: string;
}

interface LayaBundleConfig {
  max_len: number;
  head_max_len: number;
}

const PACKAGE_VERSION = '0.1.2';

function readBundleConfig(modelDir: string): Result<LayaBundleConfig> {
  try {
    const raw = readFileSync(join(modelDir, 'laya_config.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<LayaBundleConfig>;
    if (typeof parsed.max_len !== 'number' || typeof parsed.head_max_len !== 'number') {
      return err('UNSUPPORTED', 'laya_config.json lacks max_len/head_max_len');
    }
    return ok({ max_len: parsed.max_len, head_max_len: parsed.head_max_len });
  } catch (error) {
    return err('UNSUPPORTED', `laya_config.json unreadable: ${(error as Error).message}`);
  }
}

export class LayaProvider implements DecisionProvider {
  readonly providerId: ProviderId = 'laya';
  private readonly config: LayaConfig;
  private instance: Laya | null = null;
  private loading: Promise<Laya> | null = null;

  constructor(config: LayaConfig = {}) {
    this.config = config;
  }

  private async load(): Promise<Result<Laya>> {
    if (this.instance !== null) return ok(this.instance);
    if (this.config.modelDir === undefined) {
      return err(
        'PROVIDER_FAILED',
        'Laya ONNX checkpoint not configured; provider blocked (set providers.laya.modelDir)',
      );
    }
    if (this.loading === null) {
      this.loading = Laya.load({
        modelDir: this.config.modelDir,
        executionProviders: ['cpu'],
        sessionOptions: { intraOpNumThreads: Math.min(4, cpus().length) },
      })
        .then((instance) => {
          this.instance = instance;
          return instance;
        })
        .catch((error: unknown) => {
          this.loading = null;
          throw error;
        });
    }
    try {
      return ok(await this.loading);
    } catch (error) {
      return err('PROVIDER_FAILED', `Laya runtime failed to load: ${(error as Error).message}`);
    }
  }

  async health(): Promise<Result<ProviderManifest>> {
    const loaded = await this.load();
    if (!loaded.ok) return loaded;
    const instance = loaded.value;

    const probeQuestion: ChoiceQuestion = {
      id: 'q-synthetic-health',
      instruction: 'Synthetic health probe: select the category of this fixture invoice.',
      options: [
        { id: 'cat-invoices', description: 'Invoice and billing documents' },
        { id: 'cat-media', description: 'Photos, video and audio' },
        { id: 'unknown', description: 'Unknown or insufficient evidence' },
      ],
    };
    try {
      const response = await instance.systemOne(
        {
          basename: 'synthetic-invoice-fixture.txt',
          detectedFormat: 'text',
          sizeBytes: 21,
          compactText: 'synthetic fixture invoice for health probe text',
        },
        toLayaQuestions(probeQuestion),
      );
      const answer = response.answers[probeQuestion.id];
      if (answer === undefined || answer.type !== 'choice') {
        return err('PROVIDER_FAILED', 'Laya health probe returned no choice answer');
      }
      const mapped = toChoiceAnswer(probeQuestion.id, answer);
      const validated = validateChoiceAnswer(mapped, probeQuestion);
      if (!validated.ok) {
        return err('PROVIDER_FAILED', `Laya health answer is not a valid distribution: ${validated.detail}`);
      }
      const bundle = this.config.modelDir === undefined ? null : readBundleConfig(this.config.modelDir);
      const limits = bundle !== null && bundle.ok ? bundle.value : null;
      return ok({
        provider: 'laya',
        modelRevision: `laya-onnx@${PACKAGE_VERSION}`,
        runtimeRevision: 'onnxruntime-node',
        tokenizerRevision: `tokenizer@${this.config.modelDir ?? 'unknown'}`,
        // Real bundle limits (laya_config.json), not documentation claims.
        questionTokenLimit: limits?.head_max_len ?? null,
        inputTokenLimit: limits?.max_len ?? null,
        endpoint: null,
      });
    } catch (error) {
      return err('PROVIDER_FAILED', `Laya health probe failed: ${(error as Error).message}`);
    }
  }

  async decide(request: DecisionRequest): Promise<Result<Decision>> {
    const question = request.questions[0];
    if (question === undefined) {
      return err('INVALID_DECISION', 'decision request contains no question');
    }
    const loaded = await this.load();
    if (!loaded.ok) return loaded;

    const startedAt = Date.now();
    try {
      const response = await loaded.value.systemOne(
        request.evidence.state,
        toLayaQuestions(question),
      );
      const answer = response.answers[question.id];
      if (answer === undefined || answer.type !== 'choice') {
        return err('INVALID_DECISION', 'Laya returned no choice answer for the question');
      }
      const mapped = toChoiceAnswer(question.id, answer);
      const validated = validateChoiceAnswer(mapped, question);
      if (!validated.ok) {
        return err('INVALID_DECISION', `Laya returned an invalid distribution: ${validated.detail}`);
      }
      return ok({
        id: `decision-${question.id}`,
        itemId: request.evidence.itemId,
        provider: 'laya',
        modelRevision: `laya-onnx@${PACKAGE_VERSION}`,
        runtimeRevision: 'onnxruntime-node',
        evidenceHash: request.evidence.stateHash,
        schemaHash: request.schemaHash,
        answers: [mapped],
        elapsedMs: Date.now() - startedAt,
        tokenCounts: { input: response.usage.input_tokens },
        error: null,
      });
    } catch (error) {
      return err('PROVIDER_FAILED', `Laya decision failed: ${(error as Error).message}`);
    }
  }

  async close(): Promise<void> {
    if (this.instance !== null) {
      const instance = this.instance;
      this.instance = null;
      this.loading = null;
      await instance.close();
    }
  }
}

interface LayaChoiceAnswerResponse {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

function toLayaQuestions(question: ChoiceQuestion): Record<string, LayaChoiceQuestion> {
  const criteria: Record<string, string> = {};
  for (const option of question.options) {
    criteria[option.id] = option.description;
  }
  return {
    [question.id]: {
      type: 'choice',
      instructions: question.instruction,
      criteria,
    },
  };
}

function toChoiceAnswer(questionId: string, answer: LayaChoiceAnswerResponse) {
  return {
    questionId,
    selectedId: answer.choice,
    probabilities: answer.probabilities,
    providerConfidence: answer.confidence,
  };
}
