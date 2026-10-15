/**
 * Reading one file the walk found: its head, and what to write down about it.
 *
 * Split out of `scan-root.ts` for the same reason `list-directory.ts` was split
 * out of `scanner.ts`: *what is this file* is a different question from *where
 * does the walk go next*. Keeping them apart also keeps both files readable and
 * gives the "we could not read this file" rule one home.
 *
 * The rule it encodes: a file the walk could not read is not a file that is
 * gone. A failure with `ENOENT` means the file was listed and then removed, so
 * its old row is evidence of nothing and may be retired. Any other failure
 * (`EACCES`, `ELOOP`, `EIO`) is a fact about this scan's access, not about the
 * file, so the caller must leave the existing row exactly as it was. That is
 * what `protect` tells it to do.
 *
 * Nothing here creates, moves, modifies or deletes anything inside a root: the
 * file is opened read-only, for at most `MAGIC_PREFIX_BYTES` bytes.
 */
import { lstat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { errorCode, messageOf } from '../shared/errors.js';
import { detectKind, extensionOf, MAGIC_PREFIX_BYTES } from './kinds.js';
import { openRegularFile } from './open.js';
import type { ItemRow, ItemStatus } from './store.js';

/** How a file is opened for its head read. Injectable for tests (see `ScanHooks`). */
export type OpenFile = (absPath: string) => Promise<FileHandle>;

const INCOMPLETE_EXTENSIONS: ReadonlySet<string> = new Set(['part', 'crdownload', 'download', 'tmp']);

function statusFor(name: string): ItemStatus {
  return INCOMPLETE_EXTENSIONS.has(extensionOf(name)) ? 'incomplete' : 'present';
}

/**
 * The head of a file, or the failure that stopped us reading it.
 *
 * A failure is returned rather than swallowed: answering `null` for every open
 * error is indistinguishable from a file whose first bytes really are empty, so
 * an unreadable file would be catalogued as an ordinary empty one.
 */
type HeadResult = { ok: true; head: Buffer } | { ok: false; code: string; message: string };

/** Reads at most `MAGIC_PREFIX_BYTES` from the head of a file. */
async function readHead(absPath: string, openFile: OpenFile): Promise<HeadResult> {
  let handle;
  try {
    handle = await openFile(absPath);
  } catch (error) {
    return { ok: false, code: errorCode(error), message: messageOf(error) };
  }
  try {
    const buffer = Buffer.alloc(MAGIC_PREFIX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAGIC_PREFIX_BYTES, 0);
    return { ok: true, head: buffer.subarray(0, bytesRead) };
  } catch (error) {
    return { ok: false, code: errorCode(error), message: messageOf(error) };
  } finally {
    await handle.close();
  }
}

/** One entry the walk found in a directory, and where it sits. */
export interface FileEntryRequest {
  rootId: number;
  scanId: number;
  /** The directory's id, as returned by `upsertDir`. */
  dirId: number;
  /** The directory's path relative to the root; `''` for the root itself. */
  rel: string;
  /** The entry's name inside the directory. */
  name: string;
  /** The directory's absolute path. */
  dirAbsPath: string;
}

/** The row to store, or the failure to record and what it means for the old row. */
export type FileEntryResult =
  | { ok: true; item: ItemRow }
  | { ok: false; code: string; message: string; protect: boolean };

/**
 * Reads one file: `lstat` for its identity, then its head for its kind.
 *
 * `openFile` defaults to the one safe door (`openRegularFile`); a test may pass
 * a different one to make a single file fail as if it were unreadable, which a
 * `chmod` cannot do under root (see `ScanHooks.openFile`).
 */
export async function readFileEntry(
  request: FileEntryRequest,
  openFile: OpenFile = openRegularFile,
): Promise<FileEntryResult> {
  const { rootId, scanId, dirId, rel, name, dirAbsPath } = request;
  const absPath = join(dirAbsPath, name);

  let stat;
  try {
    stat = await lstat(absPath, { bigint: true });
  } catch (error) {
    return failed(errorCode(error), messageOf(error));
  }
  const head = await readHead(absPath, openFile);
  if (!head.ok) return failed(head.code, head.message);

  return {
    ok: true,
    item: {
      rootId,
      relPath: rel === '' ? name : `${rel}/${name}`,
      dirId,
      name,
      ext: extensionOf(name),
      kind: detectKind(name, head.head),
      size: Number(stat.size),
      mtimeNs: stat.mtimeNs.toString(),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      nlink: Number(stat.nlink),
      status: statusFor(name),
      scanId,
    },
  };
}

/** A read failure, and whether it is evidence that the file is gone. */
function failed(code: string, message: string): FileEntryResult {
  // `ENOENT` is a deletion: the walk listed the file and it then went away.
  // Anything else leaves the existing row alone, so one `EACCES` does not look
  // exactly like a file the user deleted.
  return { ok: false, code, message, protect: code !== 'ENOENT' };
}
