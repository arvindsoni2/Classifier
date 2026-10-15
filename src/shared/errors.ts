/**
 * Reading `code` and `message` off a thrown value.
 *
 * `catch` hands back `unknown`, and the catalogue records the operating system's
 * own classification verbatim rather than inventing one: `scan_errors.code` is
 * `EACCES`, `ENOENT`, `ELOOP` and so on, because that is what a user's `dmesg`,
 * `man` page and bug report will say. Both helpers are here rather than in one
 * caller because the walk and the per-file read both need them.
 */

/** A thrown value's `code`, when it has a string one; `UNKNOWN` otherwise. */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

/** A thrown value's message, kept verbatim. */
export function messageOf(error: unknown): string {
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : String(error);
}
