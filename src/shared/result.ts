/**
 * The `Result` type shared code outside the domain uses.
 *
 * Spec §8 forbids new code reaching into `src/domain/` for types, and the ZIP
 * reader is now shared between the extraction adapter and two catalogue
 * extractors — one of which has nothing to do with the domain. Rather than have
 * `src/shared/` depend on `src/domain/`, the shape lives here.
 *
 * It is deliberately the same shape as the domain's `Result`, so a caller that
 * already handles one handles the other, but the codes here are the reader's own:
 * a ZIP that cannot be read is not an item that is out of scope.
 */

/**
 * Why a read failed. These are the codes the ZIP reader can actually produce,
 * and they are a subset of the domain's `ErrorCode`, so a `Result` from here
 * stays assignable to the domain's and callers handle both with one signature.
 */
export type ZipErrorCode = 'EXTRACTION_FAILED' | 'OVERSIZE';

/** A value, or the reason there is not one. Never an exception. */
export type Result<T> = { ok: true; value: T } | { ok: false; code: ZipErrorCode; detail: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const err = <T = never>(code: ZipErrorCode, detail: string): Result<T> => ({
  ok: false,
  code,
  detail,
});