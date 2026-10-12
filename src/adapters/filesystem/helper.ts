/**
 * Typed bridge to the Linux helper (LLD §1, plan Task 7).
 *
 * One JSON request per invocation, max 64 KiB, argument-array spawning only
 * — no shell. The helper owns every kernel primitive (openat2 anchoring,
 * RENAME_NOREPLACE, directory fsync); this module translates contracts and
 * never opens paths itself.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  err,
  ok,
  type ApprovedMove,
  type Destination,
  type ErrorCode,
  type Id,
  type MoveReceipt,
  type Result,
  type RootConfig,
  type Snapshot,
} from '../../domain/contracts.js';

const MAX_REQUEST_BYTES = 64 * 1024;
const HELPER_TIMEOUT_MS = 60_000;

export interface FilesystemHealth {
  kernel: string;
  openat2: boolean;
  renameat2Noreplace: boolean;
  rootVerified: boolean;
}

/** Default helper location; override via FSOPS_BINARY for deployments. */
export function defaultHelperBinary(): string {
  return process.env.FSOPS_BINARY ?? join(process.cwd(), 'native', 'fsops', 'target', 'release', 'fsops');
}

interface HelperResponse {
  ok: boolean;
  code?: string;
  detail?: string;
  health?: FilesystemHealth;
  snapshot?: Snapshot;
  receipt?: MoveReceipt;
  destination?: Destination;
}

const KNOWN_CODES: readonly ErrorCode[] = [
  'OUT_OF_SCOPE',
  'NOT_FOUND',
  'UNSTABLE',
  'OVERSIZE',
  'UNSUPPORTED',
  'EXTRACTION_FAILED',
  'INPUT_TOO_LONG',
  'PROVIDER_FAILED',
  'INVALID_DECISION',
  'STALE',
  'COLLISION',
  'CROSS_MOUNT',
  'UNSUPPORTED_KERNEL',
  'CONFLICT',
  'UNAUTHORISED',
];

function errorCodeOf(code: string | undefined): ErrorCode {
  if (code !== undefined && KNOWN_CODES.includes(code as ErrorCode)) return code as ErrorCode;
  return 'UNSUPPORTED';
}

/** Runs one helper request; resolves with the parsed envelope. */
async function runHelper(
  binaryPath: string,
  request: unknown,
): Promise<Result<unknown>> {
  if (!existsSync(binaryPath)) {
    return err(
      'UNSUPPORTED',
      `helper binary not found at ${binaryPath}; build it with ` +
        '`cargo build --release --manifest-path native/fsops/Cargo.toml` (plan Task 7)',
    );
  }
  const payload = JSON.stringify(request);
  if (payload.length > MAX_REQUEST_BYTES) {
    return err('UNSUPPORTED', 'request exceeds the 64 KiB protocol limit');
  }

  return new Promise((resolve) => {
    const child = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, HELPER_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length);
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      resolve(err('UNSUPPORTED', `helper could not be spawned: ${error.message}`));
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (timedOut) {
        resolve(err('UNSUPPORTED', `helper timed out after ${HELPER_TIMEOUT_MS}ms and was killed`));
        return;
      }
      let parsed: HelperResponse;
      try {
        parsed = JSON.parse(stdout) as HelperResponse;
      } catch {
        resolve(
          err(
            'UNSUPPORTED',
            `helper did not return JSON (stderr: ${stderr.trim().slice(0, 200) || 'empty'})`,
          ),
        );
        return;
      }
      if (parsed.ok !== true) {
        resolve(err(errorCodeOf(parsed.code), parsed.detail ?? 'helper refused the request'));
        return;
      }
      resolve(ok(parsed));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
  });
}

function field<T>(result: Result<unknown>, key: 'health' | 'snapshot' | 'receipt' | 'destination'): Result<T> {
  if (!result.ok) return result;
  const value = (result.value as Record<string, unknown>)[key];
  if (value === undefined) return err('UNSUPPORTED', `helper response carried no ${key}`);
  return ok(value as T);
}

/** Probes kernel primitives and the recorded root identity. */
export async function probeFilesystem(
  root: RootConfig,
  binaryPath: string = defaultHelperBinary(),
): Promise<Result<FilesystemHealth>> {
  return field<FilesystemHealth>(await runHelper(binaryPath, { verb: 'probe', root }), 'health');
}

/** Inspects one file beneath the root into a snapshot. */
export async function inspectAt(
  root: RootConfig,
  segments: readonly string[],
  binaryPath: string = defaultHelperBinary(),
): Promise<Result<Snapshot>> {
  return field<Snapshot>(await runHelper(binaryPath, { verb: 'inspect', root, segments }), 'snapshot');
}

/** Creates one approved directory segment beneath the pinned parent. */
export async function mkdirAt(
  root: RootConfig,
  parent: Destination,
  segment: string,
  binaryPath: string = defaultHelperBinary(),
): Promise<Result<Destination>> {
  return field<Destination>(
    await runHelper(binaryPath, {
      verb: 'mkdir',
      root,
      parent: { segments: parent.segments, device: parent.device, inode: parent.inode },
      segment,
    }),
    'destination',
  );
}

/**
 * Executes one approved move. The resolved root is supplied explicitly
 * (Task 8 resolves rootId through the repository); the destination pin is
 * the discovery-time identity, so a mismatch is a deferred cross-mount.
 * RENAME_NOREPLACE lives inside the helper.
 */
export async function moveAt(
  action: ApprovedMove,
  root: RootConfig,
  destination: Destination,
  binaryPath: string = defaultHelperBinary(),
): Promise<Result<MoveReceipt>> {
  return field<MoveReceipt>(
    await runHelper(binaryPath, {
      verb: 'move',
      root,
      actionId: action.actionId,
      requestId: `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      sourceBasename: action.sourceBasename,
      destination: {
        segments: destination.segments,
        device: destination.device,
        inode: destination.inode,
      },
      expected: action.expected,
      approvalId: action.approvalId,
    }),
    'receipt',
  );
}

export interface UndoAction {
  actionId: Id;
  approvalId: Id;
  basename: string;
  targetSegments: string[];
  expected: Snapshot;
}

/** Executes one approved undo: the inverse move back into the root. */
export async function undoAt(
  action: UndoAction,
  root: RootConfig,
  binaryPath: string = defaultHelperBinary(),
): Promise<Result<MoveReceipt>> {
  return field<MoveReceipt>(
    await runHelper(binaryPath, {
      verb: 'undo',
      root,
      actionId: action.actionId,
      requestId: `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      targetSegments: action.targetSegments,
      basename: action.basename,
      expected: action.expected,
      approvalId: action.approvalId,
    }),
    'receipt',
  );
}
