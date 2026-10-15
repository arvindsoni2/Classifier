/**
 * Opening a file the catalogue is going to read (plan Task 7 item 1).
 *
 * Every read of a root's contents goes through here, and the flags are the whole
 * point of the module:
 *
 *  - `O_NONBLOCK` — a plain `open(path, 'r')` on a **FIFO** blocks until a
 *    writer appears, and no writer ever will. Because the catalogue lists a
 *    directory and *then* opens what it listed, anything can be swapped in
 *    between those two steps, and one FIFO would hang a scan of 40,000 files
 *    forever with no output and no error.
 *  - `O_NOFOLLOW` — the path may now be a symlink pointing anywhere on the
 *    machine. Following it would read outside the root, which is exactly what
 *    "never follow a symlink" forbids.
 *  - `O_RDONLY` — the catalogue opens nothing for writing, ever (AGENTS.md rule 4).
 *
 * The descriptor is then `fstat`ed and refused unless it is a **regular file**.
 * Opening is not the same as reading: a device node or a socket can be opened
 * without blocking, and reading from one is not what "catalogue this folder"
 * means. Checking the descriptor rather than the path also closes the gap
 * between opening and checking — the thing inspected is the thing that was
 * opened.
 */
import { constants, open, type FileHandle } from 'node:fs/promises';

/** The flags every catalogue read uses. See the module comment for each one. */
export const READ_ONLY_SAFE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** The code recorded when the opened descriptor is not a regular file. */
export const NOT_A_REGULAR_FILE = 'NOT_A_REGULAR_FILE';

/** How the kernel calls it, for a message a person can act on. */
function describeKind(stat: Awaited<ReturnType<FileHandle['stat']>>): string {
  if (stat.isFIFO()) return 'a fifo';
  if (stat.isSocket()) return 'a socket';
  if (stat.isCharacterDevice()) return 'a character device';
  if (stat.isBlockDevice()) return 'a block device';
  if (stat.isDirectory()) return 'a directory';
  return 'not a regular file';
}

/** An error carrying a `code`, so callers can classify it like any `fs` failure. */
function codedError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

function notARegularFile(absPath: string, stat: Awaited<ReturnType<FileHandle['stat']>>): Error {
  return codedError(
    NOT_A_REGULAR_FILE,
    `refusing to read ${absPath}: it is ${describeKind(stat)}, not a regular file`,
  );
}

/**
 * Opens a regular file read-only, safely. Throws with `code`
 * `NOT_A_REGULAR_FILE` when the descriptor is anything else; the caller closes
 * the handle only on success, because this function closes it on every failure
 * path it can reach.
 */
export async function openRegularFile(absPath: string): Promise<FileHandle> {
  const handle = await open(absPath, READ_ONLY_SAFE_FLAGS);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw notARegularFile(absPath, stat);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}