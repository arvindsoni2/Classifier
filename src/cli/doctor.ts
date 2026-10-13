/**
 * Provider health doctor (plan Task 4). Reports per-provider ok/blocked
 * status honestly: a missing checkpoint, unreachable endpoint or absent
 * cloud consent is recorded as blocked with its reason — never substituted
 * by another provider or a chat completion. Local configuration is read from
 * the gitignored config/local/providers.json.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderId, ProviderManifest, Result } from '../domain/contracts.js';
import { RulesProvider } from '../adapters/providers/rules.js';
import { LayaProvider } from '../adapters/providers/laya.js';
import { ClefProvider, type ClefTransport } from '../adapters/providers/clef.js';
import { JevProvider } from '../adapters/providers/jev.js';

export interface ProviderConfig {
  /** Bundle directory for the pinned @receptron/laya ONNX runtime. */
  laya?: { modelDir?: string };
  clef?: { endpoint?: string };
  jev?: { consentScope?: { datasetId: string; subset: string; recordedAt: string }; endpoint?: string; verifiedContract?: { contractRevision: string; verifiedAt: string } };
}

export interface ProviderHealth {
  provider: ProviderId;
  status: 'ok' | 'blocked';
  manifest?: ProviderManifest;
  detail: string;
}

export interface DoctorDeps {
  transport?: ClefTransport;
  deadlineMs?: number;
  healthTimeoutMs?: number;
}

export function loadProviderConfig(
  path?: string,
  env: Record<string, string | undefined> = process.env,
): ProviderConfig {
  const resolved =
    path ?? env.ORGANISER_PROVIDER_CONFIG ?? join(process.cwd(), 'config', 'local', 'providers.json');
  if (!existsSync(resolved)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolved, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as ProviderConfig;
    }
  } catch {
    // Malformed local config: report empty and let probes surface the blocks.
  }
  return {};
}

async function record(
  provider: ProviderId,
  result: Promise<Result<ProviderManifest>>,
): Promise<ProviderHealth> {
  const resolved = await result;
  if (resolved.ok) {
    return { provider, status: 'ok', manifest: resolved.value, detail: 'healthy' };
  }
  return { provider, status: 'blocked', detail: `${resolved.code}: ${resolved.detail}` };
}

export async function probeProviders(
  config: ProviderConfig = loadProviderConfig(),
  deps: DoctorDeps = {},
): Promise<ProviderHealth[]> {
  const transportDeps = (): {
    transport?: ClefTransport;
    deadlineMs?: number;
    healthTimeoutMs?: number;
  } => {
    const injected: { transport?: ClefTransport; deadlineMs?: number; healthTimeoutMs?: number } = {};
    if (deps.transport !== undefined) injected.transport = deps.transport;
    if (deps.deadlineMs !== undefined) injected.deadlineMs = deps.deadlineMs;
    if (deps.healthTimeoutMs !== undefined) injected.healthTimeoutMs = deps.healthTimeoutMs;
    return injected;
  };

  // Probes run concurrently, so `doctor` costs the SLOWEST provider instead of
  // the sum of all of them. Reported order stays fixed for stable output.
  const rules = new RulesProvider();
  const laya = new LayaProvider(config.laya ?? {});
  const clef =
    config.clef?.endpoint === undefined
      ? null
      : new ClefProvider({ endpoint: config.clef.endpoint }, transportDeps());
  const jev = new JevProvider(config.jev ?? {}, transportDeps());

  const [rulesHealth, layaHealth, clefHealth, jevHealth] = await Promise.all([
    record('rules', rules.health()),
    record('laya', laya.health()),
    clef === null
      ? Promise.resolve<ProviderHealth>({
          provider: 'clef',
          status: 'blocked',
          detail: 'no endpoint configured in config/local/providers.json',
        })
      : record('clef', clef.health()),
    record('jev', jev.health()),
  ]);

  await Promise.all([rules.close(), laya.close(), clef?.close(), jev.close()]);

  return [rulesHealth, layaHealth, clefHealth, jevHealth];
}

export async function main(): Promise<void> {
  const config = loadProviderConfig();
  const health = await probeProviders(config);
  const output = {
    recordedAt: new Date().toISOString(),
    configSource: 'config/local/providers.json (gitignored)',
    providers: health,
  };
  console.log(JSON.stringify(output, null, 2));
}

const isMain =
  process.argv[1] !== undefined && process.argv[1].endsWith('doctor.js');
if (isMain) {
  await main();
}
