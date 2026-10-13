/**
 * Bounded subprocess execution for the metadata extractors (plan Task 4,
 * AGENTS.md rule 6).
 *
 * Every child is spawned with an argument array and no shell, so nothing in a
 * file name can become a command. Three bounds apply to every call regardless
 * of what the tool decides to do: a deadline, a cap on collected stdout, and a
 * cap on stderr. A tool that overruns is killed outright rather than left to
 * finish, and a tool that floods is truncated rather than buffered.
 */
import { spawn } from 'node:child_process';

export interface RunToolOptions {
  /** Deadline in milliseconds; the child is killed when it expires. */
  timeoutMs: number;
  /** Parent-side cap on collected stdout. Defaults to 1 MiB. */
  maxOutputBytes?: number;
  /** Aborts the child when the caller's own signal fires. */
  signal?: AbortSignal;
}

export interface RunToolResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** The deadline expired and the child was killed. */
  timedOut: boolean;
  /** Output was longer than the cap; what is here is the beginning. */
  truncated: boolean;
  /** The tool could not be started at all — absent from PATH, not executable. */
  spawnFailed: boolean;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_STDERR_CHARS = 4096;

/**
 * Runs `command` with `args` and resolves with its result.
 *
 * This never rejects for a child that fails, hangs or floods: those are all
 * ordinary outcomes for an unknown file on someone's disk, and the caller
 * records them as statuses. Only a caller-side bug would throw here.
 */
export function runTool(
  command: string,
  args: readonly string[],
  options: RunToolOptions,
): Promise<RunToolResult> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks: Buffer[] = [];
    let collected = 0;
    let truncated = false;
    let stderr = '';
    let timedOut = false;
    let spawnFailed = false;
    let settled = false;

    const kill = (): void => {
      child.kill('SIGKILL');
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const onAbort = (): void => kill();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        stdout: Buffer.concat(chunks),
        stderr,
        timedOut,
        truncated,
        spawnFailed,
      });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      const room = maxOutputBytes - collected;
      if (room <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        collected = maxOutputBytes;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      collected += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS) {
        stderr += chunk.toString('utf8').slice(0, MAX_STDERR_CHARS - stderr.length);
      }
    });
    child.on('error', () => {
      // ENOENT and EACCES land here: the tool is not usable on this machine.
      spawnFailed = true;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}