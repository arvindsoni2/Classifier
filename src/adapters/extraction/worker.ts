/**
 * Bounded extraction worker (plan Task 3, PRD §6): one child process at a
 * time, 10-second timeout, 512 MiB memory limit. Every child runs under
 * `prlimit --as=<bytes> --` with an argument array — no shell, ever. A stuck
 * child is killed with SIGKILL at the deadline.
 */
import { spawn } from 'node:child_process';

export interface ChildRunOptions {
  timeoutMs: number;
  memoryLimitBytes: number;
  prlimitPath: string;
}

export interface ChildRunResult {
  code: number | null;
  signal: string | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

const MAX_STDERR_CHARS = 4096;

/** Spawns `prlimit --as=<memory> -- <command> <args...>` with piped stdio. */
export function runChild(
  input: Buffer,
  command: string,
  args: readonly string[],
  options: ChildRunOptions,
): Promise<ChildRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      options.prlimitPath,
      [`--as=${options.memoryLimitBytes}`, '--', command, ...args],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const stdoutChunks: Buffer[] = [];
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS) {
        stderr += chunk.toString('utf8').slice(0, MAX_STDERR_CHARS - stderr.length);
      }
    });
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal: signal ?? null,
        stdout: Buffer.concat(stdoutChunks),
        stderr,
        timedOut,
      });
    });
    // EPIPE on early child death is surfaced through the close event.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
