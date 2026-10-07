/**
 * Synthetic fixture builders for filesystem discovery tests (plan Task 2).
 * Automated tests only ever use synthetic roots under /tmp/opencode —
 * never the user's actual Downloads (AGENTS.md rule 12).
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface FixtureRoot {
  /** Synthetic organisation root (the fake "Downloads"). */
  root: string;
  /** Parent directory holding the root and outside-root sentinels. */
  parent: string;
  cleanup(): void;
}

export function makeFixtureRoot(label: string): FixtureRoot {
  const parent = mkdtempSync(join('/tmp/opencode', `discovery-${label}-`));
  const root = join(parent, 'Downloads');
  mkdirSync(root);
  return {
    root,
    parent,
    cleanup: () => rmSync(parent, { recursive: true, force: true }),
  };
}

export function putFile(root: string, name: string, content = 'fixture content\n'): string {
  writeFileSync(join(root, name), content, 'utf8');
  return name;
}

export function putNestedFile(root: string, segments: string[], name: string, content = 'nested\n'): string {
  const dir = join(root, ...segments);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content, 'utf8');
  return name;
}

export function putDirectory(root: string, segments: string[]): string {
  const dir = join(root, ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function putSymlink(root: string, name: string, target: string): string {
  symlinkSync(target, join(root, name));
  return name;
}

export function putHardLink(root: string, existing: string, newName: string): string {
  linkSync(join(root, existing), join(root, newName));
  return newName;
}

export function putSparseFile(root: string, name: string, bytes: number): string {
  const path = join(root, name);
  writeFileSync(path, '');
  truncateSync(path, bytes);
  return name;
}

export function putUnreadableFile(root: string, name: string, content = 'secrets\n'): string {
  const path = join(root, name);
  writeFileSync(path, content, 'utf8');
  chmodSync(path, 0o000);
  return name;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Read-only outside-root evidence: every regular file and symlink under
 * `dir`, mapped to `relpath -> sha256(bytes)` (or `link -> target`). Used to
 * prove discovery leaves everything outside the candidate scope unchanged.
 */
export function treeFingerprint(dir: string): Map<string, string> {
  const fingerprint = new Map<string, string>();
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        fingerprint.set(rel, `link:${readlinkSync(path)}`);
      } else if (entry.isFile()) {
        try {
          fingerprint.set(rel, sha256Hex(readFileSync(path)));
        } catch {
          fingerprint.set(rel, 'unreadable');
        }
      } else if (entry.isDirectory()) {
        fingerprint.set(rel, 'dir');
        walk(path, rel);
      }
    }
  };
  walk(dir, '');
  return fingerprint;
}

/** Bigint stat fields as decimal strings, matching Snapshot conventions. */
export function statStrings(path: string): { device: string; inode: string; size: string; mtimeNs: string; ctimeNs: string } {
  const st = statSync(path, { bigint: true });
  return {
    device: st.dev.toString(),
    inode: st.ino.toString(),
    size: st.size.toString(),
    mtimeNs: st.mtimeNs.toString(),
    ctimeNs: st.ctimeNs.toString(),
  };
}
