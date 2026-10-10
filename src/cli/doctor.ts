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
  jev?: { consentReference?: string; endpoint?: string };
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
}

export function loadProviderConfig(
  path: string = join(process.cwd(), 'config', 'local', 'providers.json'),
): ProviderConfig {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
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
  const health: ProviderHealth[] = [];

  const rules = new RulesProvider();
  health.push(await record('rules', rules.health()));
  await rules.close();

  const laya = new LayaProvider(config.laya ?? {});
  health.push(await record('laya', laya.health()));
  await laya.close();

  const transportDeps = (): { transport?: ClefTransport; deadlineMs?: number } => {
    const injected: { transport?: ClefTransport; deadlineMs?: number } = {};
    if (deps.transport !== undefined) injected.transport = deps.transport;
    if (deps.deadlineMs !== undefined) injected.deadlineMs = deps.deadlineMs;
    return injected;
  };

  if (config.clef?.endpoint === undefined) {
    health.push({
      provider: 'clef',
      status: 'blocked',
      detail: 'no endpoint configured in config/local/providers.json',
    });
  } else {
    const clef = new ClefProvider({ endpoint: config.clef.endpoint }, transportDeps());
    health.push(await record('clef', clef.health()));
    await clef.close();
  }

  const jev = new JevProvider(config.jev ?? {}, transportDeps());
  health.push(await record('jev', jev.health()));
  await jev.close();

  return health;
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
