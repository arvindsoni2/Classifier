/**
 * Root resolution (plan Task 2, PRD §2): resolve the Downloads root through
 * the user's XDG directory configuration when available, otherwise offer
 * ~/Downloads. Read-only: resolution never creates or modifies anything.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { err, ok, type Result, type RootConfig } from '../../domain/contracts.js';

/** Reads XDG_DOWNLOAD_DIR from user-dirs.dirs; null when unconfigured. */
export function xdgDownloadsDir(home: string = homedir()): string | null {
  const configPath = join(home, '.config', 'user-dirs.dirs');
  let content: string;
  try {
    content = readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }
  const match = content.match(/^XDG_DOWNLOAD_DIR="\$HOME\/([^"\r\n]+)"/m);
  return match?.[1] ? join(home, ...match[1].split('/')) : null;
}

function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return typeof e === 'object' && e !== null && 'code' in e;
}

/**
 * Resolves a root into a pinned RootConfig: canonical absolute path,
 * recorded device/inode, inbox depth 0 and destination depth 3. The same
 * resolved path always yields the same deterministic rootId so persisted
 * state binds to one root identity.
 */
export async function resolveRoot(
  configuredPath?: string,
  options: { policyRevision?: number } = {},
): Promise<Result<RootConfig>> {
  const raw = configuredPath ?? xdgDownloadsDir() ?? join(homedir(), 'Downloads');

  let absolutePath: string;
  try {
    absolutePath = await realpath(raw);
  } catch (e) {
    return err(
      'OUT_OF_SCOPE',
      `cannot resolve root path ${raw}: ${isErrnoException(e) ? `${e.code} ${e.message}` : 'unknown error'}`,
    );
  }

  let st: { dev: number; ino: number; isDirectory(): boolean };
  try {
    st = await stat(absolutePath);
  } catch (e) {
    return err(
      'OUT_OF_SCOPE',
      `cannot stat resolved root ${absolutePath}: ${isErrnoException(e) ? `${e.code} ${e.message}` : 'unknown error'}`,
    );
  }
  if (!st.isDirectory()) {
    return err('OUT_OF_SCOPE', `resolved root ${absolutePath} is not a directory`);
  }

  const rootId = `root-${createHash('sha256').update(absolutePath).digest('hex').slice(0, 40)}`;
  return ok({
    rootId,
    absolutePath,
    device: st.dev.toString(),
    inode: st.ino.toString(),
    inboxDepth: 0,
    directoryDepth: 3,
    policyRevision: options.policyRevision ?? 1,
  });
}
