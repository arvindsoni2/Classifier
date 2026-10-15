/**
 * Filesystem-aware roots (plan Task 1b, spec D31).
 *
 * A root can sit on an external drive, and three things about that drive are
 * outside the catalogue's control: it may be unplugged, reformatted, or replaced
 * by a different drive at the same path. This module reads those facts and turns
 * them into one of three decisions per root (`decideRoot`):
 *
 * | Decision | Detected by | Effect |
 * | --- | --- | --- |
 * | offline | probe says the path is gone, or a recorded mount point is no longer one | root skipped, **no item touched** |
 * | retired | the recorded volume identity differs from the current one | old items retired, `VOLUME_CHANGED` recorded, root scanned as new |
 * | scan | same volume | ordinary incremental scan |
 *
 * The "no item touched" rule is the one that matters most: an absent drive is
 * not a deleted directory, and retiring forty thousand files because a USB
 * cable was knocked loose would be the worst thing this catalogue could do.
 *
 * The probe is an argument-array `findmnt` call, injectable so every test runs
 * on a machine with no drive attached.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * What a probe found about the filesystem a path sits on.
 *
 * `uuid` is null for filesystems that have none — vfat has no filesystem UUID at
 * all, and neither do some FUSE mounts — which is exactly why the uuid cannot
 * be the only identity signal.
 */
export interface VolumeInfo {
  uuid: string | null;
  label: string | null;
  fstype: string;
  /** Where that filesystem is mounted; the root path itself when it is one. */
  mountPoint: string;
}

/** Reports the filesystem at `path`, or null when the path does not exist. */
export type VolumeProbe = (path: string) => Promise<VolumeInfo | null>;

/** Filesystems where an inode number identifies a file across scans. */
const INODE_IDENTITY_FS: ReadonlySet<string> = new Set(['ext4', 'xfs', 'btrfs', 'f2fs', 'ext3', 'ext2']);

/** Deadline for the probe, per the plan. A stuck findmnt must not stall a scan. */
const PROBE_TIMEOUT_MS = 5_000;
/** findmnt's answer is a few hundred bytes; anything larger is not its output. */
const PROBE_MAX_OUTPUT_BYTES = 256 * 1024;

/** inode|path: the only thing a filesystem type decides here. */
export function identityModeFor(fstype: string): 'inode' | 'path' {
  return INODE_IDENTITY_FS.has(fstype) ? 'inode' : 'path';
}

/**
 * Reads one filesystem out of `findmnt --json` output.
 *
 * Returns null when there is nothing to read: no filesystems, no mount target,
 * no filesystem type, or output that is not the JSON we asked for. Parsing
 * starts at the first `{` rather than at the first byte, because findmnt prints
 * a warning line before the JSON when a mount point has gone stale.
 */
export function parseFindmnt(stdout: string): VolumeInfo | null {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
  const filesystems = (parsed as { filesystems?: unknown }).filesystems;
  if (!Array.isArray(filesystems) || filesystems.length === 0) return null;
  const first = filesystems[0] as Record<string, unknown>;
  const { target, fstype, uuid, label } = first;
  if (typeof target !== 'string' || target === '') return null;
  if (typeof fstype !== 'string' || fstype === '') return null;
  return {
    uuid: typeof uuid === 'string' && uuid !== '' ? uuid : null,
    label: typeof label === 'string' && label !== '' ? label : null,
    fstype,
    mountPoint: target,
  };
}

/** Whether `findmnt` can be run at all on this machine. */
export async function findmntAvailable(): Promise<boolean> {
  return !(await runFindmnt(['--version'])).spawnFailed;
}

function runFindmnt(args: readonly string[]): Promise<{ stdout: string; spawnFailed: boolean }> {
  return new Promise((resolve) => {
    // Argument array, never a shell (AGENTS.md rule 6): the path is data.
    const child = spawn('findmnt', [...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let collected = 0;
    let spawnFailed = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (collected >= PROBE_MAX_OUTPUT_BYTES) return;
      chunks.push(chunk);
      collected += chunk.length;
    });
    child.on('error', () => {
      spawnFailed = true;
      resolve({ stdout: '', spawnFailed: true });
    });
    child.on('close', () => resolve({ stdout: Buffer.concat(chunks).toString('utf8'), spawnFailed }));
    setTimeout(() => child.kill('SIGKILL'), PROBE_TIMEOUT_MS).unref();
  });
}

/**
 * The real probe: `findmnt --json --output UUID,LABEL,FSTYPE,TARGET --target
 * <path>`.
 *
 * A path that does not exist is reported as null without spawning anything,
 * which is the common case for an unplugged drive and costs nothing.
 */
export const defaultVolumeProbe: VolumeProbe = async (path) => {
  if (!existsSync(path)) return null;
  const run = await runFindmnt(['--json', '--output', 'UUID,LABEL,FSTYPE,TARGET', '--target', path]);
  if (run.spawnFailed) return null;
  return parseFindmnt(run.stdout);
};

/** What the catalogue knows about a root from previous scans. */
export interface KnownRoot {
  volumeUuid: string | null;
  fstype: string | null;
  isMountPoint: boolean | null;
}

/** The decision for one root, taken before anything is walked. */
export type RootDecision =
  | { kind: 'offline'; reason: string }
  | { kind: 'retired'; previousUuid: string | null; previousFstype: string | null; current: VolumeInfo }
  | { kind: 'scan'; current: VolumeInfo };

/**
 * Decides what to do with a root, given what a probe found now and what the
 * catalogue recorded last time.
 *
 * Offline is decided first: a drive that is not there cannot be compared with
 * what it used to hold, and nothing about its files is knowable.
 *
 * A root with no recorded filesystem type has no volume identity yet — either a
 * brand-new root, or one catalogued before volumes existed. It is scanned, never
 * retired: retiring a root on its first volume-aware scan would mark a machine's
 * entire catalogue missing after a schema migration.
 */
export function decideRoot(rootPath: string, current: VolumeInfo | null, known: KnownRoot | null): RootDecision {
  if (current === null) {
    return { kind: 'offline', reason: 'the path is not present' };
  }
  if (known === null || known.fstype === null) {
    return { kind: 'scan', current };
  }
  // A path that used to be a mount point and is no longer one is a drive that was
  // unplugged: what is left at that path is the empty mount point directory on
  // the parent filesystem, not the volume.
  if (known.isMountPoint === true && current.mountPoint !== rootPath) {
    return {
      kind: 'offline',
      reason: `the mount point is gone (now part of ${current.fstype} at ${current.mountPoint})`,
    };
  }
  // Both sides have a uuid: it is the identity, and a label change is not a new
  // volume. Neither side has one (vfat, some FUSE): the filesystem type is the
  // best identity available. One side having a uuid and the other not is a
  // change — the volume was reformatted, or a different drive was plugged in.
  const sameVolume =
    known.volumeUuid !== null && current.uuid !== null
      ? known.volumeUuid === current.uuid
      : known.volumeUuid === null && current.uuid === null
        ? known.fstype === current.fstype
        : false;
  if (!sameVolume) {
    return { kind: 'retired', previousUuid: known.volumeUuid, previousFstype: known.fstype, current };
  }
  return { kind: 'scan', current };
}