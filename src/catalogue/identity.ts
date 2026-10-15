/**
 * Whether a file is the same file it was at the last scan (plan Task 1b,
 * spec D31).
 *
 * Which question that is depends on the filesystem the root sits on, and getting
 * it wrong is expensive in both directions:
 *
 * - **inode** filesystems (ext4, xfs, btrfs, f2fs) hand out a stable number per
 *   file, so inode + size + mtime identifies it. A rename keeps all three, so a
 *   renamed 40 GB film is still the same film.
 * - **path** filesystems (vfat, exfat, ntfs) hand out synthetic inode numbers
 *   that change between mounts, so an inode cannot identify anything. Identity
 *   is the path plus the size, with the mtime compared at two-second precision
 *   because FAT stores times that coarsely. Nothing else about the row matters.
 *
 * `dev` is in neither: a USB drive gets a new device number every time it is
 * plugged in, so comparing it would re-hash a whole external volume on every
 * run. Within a single scan the scanner still compares it, to notice that a
 * directory is a different mount.
 *
 * A root with no recorded identity mode is treated as inode-mode: that is what
 * every root was before volumes existed, and inode identity is the stricter of
 * the two (it re-hashes a file that merely looks similar).
 */
export type IdentityMode = 'inode' | 'path';

/**
 * How far apart two timestamps may be and still be the same file, in
 * nanoseconds. FAT-family filesystems store times with two-second granularity,
 * so the same file reads back slightly different on every mount.
 *
 * The tolerance is a *distance*, not a bucket: truncating each timestamp into a
 * two-second window calls 5.9 s and 6.1 s different files whenever a boundary
 * falls between them, and re-hashes the file for an artefact of the clock.
 * BigInt throughout: nanosecond timestamps exceed Number's safe range.
 */
const MTIME_TOLERANCE_NS = 2_000_000_000n;

/** The fields identity is decided from. */
export interface ItemIdentity {
  relPath: string;
  size: number;
  mtimeNs: string;
  ino: string;
}

/** Whether two nanosecond timestamps are less than the tolerance apart. */
function mtimeWithinTolerance(previous: string, current: string): boolean {
  const drift = BigInt(previous) - BigInt(current);
  return (drift < 0n ? -drift : drift) < MTIME_TOLERANCE_NS;
}

/** inode|path: is this row the same file it was at the last scan? */
export function isUnchanged(mode: IdentityMode, previous: ItemIdentity, current: ItemIdentity): boolean {
  if (previous.size !== current.size) return false;
  if (mode === 'path') {
    // The row was found by path already, so path identity is implied; size and
    // a coarse mtime are what is left to compare.
    return mtimeWithinTolerance(previous.mtimeNs, current.mtimeNs);
  }
  return previous.ino === current.ino && previous.mtimeNs === current.mtimeNs;
}