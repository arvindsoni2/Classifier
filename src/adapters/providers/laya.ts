/**
 * Laya local ONNX decision provider (plan Task 4, docs/08 S1). Honest blocked
 * status: without the pinned ONNX checkpoint and its Node runtime package
 * on this machine, health and decide report PROVIDER_FAILED/blocked rather
 * than substituting another model or a chat completion. When both become
 * available, the real inference path is completed in a later milestone with
 * the checkpoint's own tokenizer/config (never characters-equal-tokens).
 */
import { existsSync } from 'node:fs';
import {
  err,
  ok,
  type Decision,
  type DecisionProvider,
  type DecisionRequest,
  type ProviderManifest,
  type Result,
} from '../../domain/contracts.js';

export interface LayaConfig {
  /** Absolute path to the pinned ONNX checkpoint directory/file. */
  modelPath?: string;
  /** Pinned runtime package name (receptron/laya Node package). */
  packageName?: string;
}

/** Documentation-based limits (docs/08 S1): English state max_len 512, head_max_len 192. */
export const LAYA_QUESTION_TOKEN_LIMIT = 192;
export const LAYA_INPUT_TOKEN_LIMIT = 512;

export class LayaProvider implements DecisionProvider {
  private readonly config: LayaConfig;

  constructor(config: LayaConfig = {}) {
    this.config = config;
  }

  private async runtimeAvailable(): Promise<Result<void>> {
    if (this.config.modelPath === undefined) {
      return err('PROVIDER_FAILED', 'Laya ONNX checkpoint not configured; provider blocked (no checkpoint on this machine)');
    }
    if (!existsSync(this.config.modelPath)) {
      return err('PROVIDER_FAILED', `Laya checkpoint missing at ${this.config.modelPath}; provider blocked`);
    }
    try {
      // The pinned runtime package must resolve; a missing package is blocked.
      await import(this.config.packageName ?? 'laya');
    } catch {
      return err('PROVIDER_FAILED', 'Laya runtime package unavailable; provider blocked');
    }
    return ok(undefined);
  }

  async health(): Promise<Result<ProviderManifest>> {
    const available = await this.runtimeAvailable();
    if (!available.ok) return available;
    return ok({
      provider: 'laya',
      modelRevision: this.config.modelPath ?? 'unpinned',
      runtimeRevision: this.config.packageName ?? 'laya',
      // Documentation-based limits (docs/08 S1); re-pinned when the real
      // checkpoint is loaded.
      tokenizerRevision: 'checkpoint-side (unverified on this machine)',
      questionTokenLimit: LAYA_QUESTION_TOKEN_LIMIT,
      inputTokenLimit: LAYA_INPUT_TOKEN_LIMIT,
      endpoint: null,
    });
  }

  async decide(_request: DecisionRequest): Promise<Result<Decision>> {
    const available = await this.runtimeAvailable();
    if (!available.ok) return available;
    return err(
      'PROVIDER_FAILED',
      'Laya inference is not implemented in this milestone: no checkpoint/runtime exists on this machine; provider blocked',
    );
  }

  async close(): Promise<void> {}
}
