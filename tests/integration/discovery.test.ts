import { appendFileSync, chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ErrorCode, Item, Result } from '../../src/domain/contracts.js';
import { resolveRoot } from '../../src/adapters/filesystem/root.js';
import {
  FilesystemSource,
  snapshot,
  STABILITY_WINDOW_MS,
  type DiscoveryClock,
} from '../../src/adapters/filesystem/source.js';
import {
  makeFixtureRoot,
  putDirectory,
  putFile,
  putHardLink,
  putNestedFile,
  putSparseFile,
  putSymlink,
  putUnreadableFile,
  sha256Hex,
  statStrings,
  treeFingerprint,
  type FixtureRoot,
} from '../fixtures/files.js';

/** Deterministic clock: sleep() advances time instantly, optionally mutating. */
class FakeClock implements DiscoveryClock {
  t = 0;
  onSleep: (() => void) | undefined;
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.onSleep?.();
    this.t += ms;
  }
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`unexpected error result: ${result.code}: ${result.detail}`);
  return result.value;
}

const fixtures: FixtureRoot[] = [];
afterAll(() => {
  for (const fx of fixtures) fx.cleanup();
});

describe('resolveRoot', () => {
  it('resolves a real directory into a pinned root config', async () => {
    const fx = makeFixtureRoot('resolve');
    fixtures.push(fx);
    const config = unwrap(await resolveRoot(fx.root));
    const st = statStrings(fx.root);
    expect(config.absolutePath).toBe(fx.root);
    expect(config.device).toBe(st.device);
    expect(config.inode).toBe(st.inode);
    expect(config.inboxDepth).toBe(0);
    expect(config.directoryDepth).toBe(3);
    // Deterministic root identity for the same resolved path.
    const again = unwrap(await resolveRoot(fx.root));
    expect(again.rootId).toBe(config.rootId);
  });

  it('rejects missing paths and non-directories without creating anything', async () => {
    const fx = makeFixtureRoot('resolve-bad');
    fixtures.push(fx);
    const file = putFile(fx.parent, 'plain.txt');
    const before = treeFingerprint(fx.parent);

    const bad = await resolveRoot(join(fx.parent, 'no-such-dir'));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('OUT_OF_SCOPE');

    const notDir = await resolveRoot(join(fx.parent, file));
    expect(notDir.ok).toBe(false);
    if (!notDir.ok) expect(notDir.code).toBe('OUT_OF_SCOPE');

    expect(treeFingerprint(fx.parent)).toEqual(before);
  });
});

describe('FilesystemSource.discover — only_lists_stable_direct_regular_files', () => {
  it('only stable eligible direct files become candidates; everything else has a reason', async () => {
    const fx = makeFixtureRoot('stable');
    fixtures.push(fx);

    putFile(fx.root, 'normal.txt', 'plain fixture\n');
    putFile(fx.root, 'ünïcödé-рапорт.txt', 'unicode fixture\n');
    putFile(fx.root, '$(touch marker).txt', 'shell-like name is data\n');
    putNestedFile(fx.root, ['Documents'], 'nested.txt', 'not a direct child\n');
    putDirectory(fx.root, ['Documents']);
    putSymlink(fx.root, 'link.txt', join(fx.root, 'normal.txt'));
    putSymlink(fx.root, 'dir-link', join(fx.root, 'Documents'));
    putFile(fx.root, 'download.part');
    putFile(fx.root, 'video.crdownload');
    putFile(fx.root, 'doc.download');
    putFile(fx.root, 'notes.tmp');
    putFile(fx.root, '.hidden');
    putFile(fx.root, 'hl-a.txt', 'hardlinked\n');
    putHardLink(fx.root, 'hl-a.txt', 'hl-b.txt');
    putSparseFile(fx.root, 'big.bin', 101 * 1024 * 1024);
    putFile(fx.root, 'inflight.txt', 'still downloading\n');
    putUnreadableFile(fx.root, 'secret.txt');
    // Sentinel outside the organisation root must never be touched.
    putFile(fx.parent, 'outside-sentinel.txt', 'outside bytes\n');

    const before = treeFingerprint(fx.parent);

    const clock = new FakeClock();
    clock.onSleep = () => {
      // The downloader is still writing this file between observations.
      appendFileSync(join(fx.root, 'inflight.txt'), 'more bytes\n');
    };
    const source = new FilesystemSource({ clock });
    const config = unwrap(await resolveRoot(fx.root));

    const results: Result<Item>[] = [];
    for await (const result of source.discover(config)) {
      results.push(result);
    }

    const eligible = results.filter((r): r is { ok: true; value: Item } => r.ok).map((r) => r.value);
    const excluded = results.filter(
      (r): r is { ok: false; code: ErrorCode; detail: string } => !r.ok,
    );

    expect(eligible.map((item) => item.externalId).sort()).toEqual(
      ['$(touch marker).txt', 'normal.txt', 'ünïcödé-рапорт.txt'].sort(),
    );

    for (const item of eligible) {
      expect(item.snapshot).not.toBeNull();
      expect(item.sourceKind).toBe('filesystem');
      expect(item.sourceId).toBe(config.rootId);
      expect(item.evidenceId).toBeNull();
      expect(item.displayName).toBe(item.externalId);
      expect(item.id).toMatch(/^item-/);
      expect(item.revision).toMatch(/^[0-9a-f]{16,}$/);
    }

    // Snapshot correctness against a direct read of the same file.
    const plain = eligible.find((item) => item.externalId === 'normal.txt');
    expect(plain?.snapshot?.sha256).toBe(sha256Hex('plain fixture\n'));
    const st = statStrings(join(fx.root, 'normal.txt'));
    expect(plain?.snapshot?.inode).toBe(st.inode);
    expect(plain?.snapshot?.mtimeNs).toBe(st.mtimeNs);
    expect(plain?.snapshot?.size).toBe(st.size);

    // Every excluded entry carries its name and a reason.
    const details = excluded.map((r) => r.detail).join('\n');
    for (const name of [
      'link.txt',
      'dir-link',
      'download.part',
      'video.crdownload',
      'doc.download',
      'notes.tmp',
      '.hidden',
      'hl-a.txt',
      'hl-b.txt',
      'big.bin',
      'inflight.txt',
      'secret.txt',
      'Documents',
    ]) {
      expect(details).toContain(name);
    }
    // Nested children are never listed at depth zero.
    expect(details).not.toContain('nested.txt');

    const codeByName = new Map(excluded.map((r) => [r.detail.split(':')[0] ?? '', r.code]));
    expect(codeByName.get('big.bin')).toBe('OVERSIZE');
    expect(codeByName.get('inflight.txt')).toBe('UNSTABLE');

    // Shell-like filename is data: no marker was created anywhere.
    expect(existsSync(join(fx.root, 'marker'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'marker'))).toBe(false);

    // The two observations were spaced by the stability window.
    expect(clock.t).toBeGreaterThanOrEqual(STABILITY_WINDOW_MS);

    // Outside-root bytes are unchanged by discovery. The one permitted
    // difference is inflight.txt, which THIS test mutates via onSleep to
    // simulate an active downloader; discovery itself changed nothing.
    const after = treeFingerprint(fx.parent);
    after.delete('Downloads/inflight.txt');
    const expected = new Map(before);
    expected.delete('Downloads/inflight.txt');
    expect(after).toEqual(expected);
  });
});

describe('FilesystemSource.discover — pagination', () => {
  it('serves at most 200 candidates per page and continues on the next page', async () => {
    const fx = makeFixtureRoot('pages');
    fixtures.push(fx);
    for (let i = 0; i < 202; i++) {
      putFile(fx.root, `f-${String(i).padStart(4, '0')}.txt`, `page fixture ${i}\n`);
    }
    const source = new FilesystemSource({ clock: new FakeClock() });
    const config = unwrap(await resolveRoot(fx.root));

    const page0: string[] = [];
    for await (const r of source.discover(config, 0)) if (r.ok) page0.push(r.value.externalId);
    const page1: string[] = [];
    for await (const r of source.discover(config, 1)) if (r.ok) page1.push(r.value.externalId);

    expect(page0).toHaveLength(200);
    expect(page1).toHaveLength(2);
    expect(new Set([...page0, ...page1]).size).toBe(202);
  });
});

describe('FilesystemSource.discoverDirectories', () => {
  it('reports an unreadable root as an error rather than an empty catalogue', async () => {
    const fx = makeFixtureRoot('dirs-denied');
    fixtures.push(fx);
    putDirectory(fx.root, ['Documents']);
    const source = new FilesystemSource({ clock: new FakeClock() });
    const config = unwrap(await resolveRoot(fx.root));
    chmodSync(fx.root, 0o000);
    try {
      const result = await source.discoverDirectories(config);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('OUT_OF_SCOPE');
        expect(result.detail).toMatch(/cannot be listed|permission/i);
      }
    } finally {
      chmodSync(fx.root, 0o700);
    }
  });

  it('discovers real directories to depth three, skipping symlinks, other mounts and unreadable subtrees', async () => {
    const fx = makeFixtureRoot('dirs');
    fixtures.push(fx);
    putDirectory(fx.root, ['Documents']);
    putDirectory(fx.root, ['Documents', 'Work']);
    putDirectory(fx.root, ['Documents', 'Work', '2026']);
    putDirectory(fx.root, ['Documents', 'Work', '2026', 'Q1']); // depth four: excluded
    putDirectory(fx.root, ['Media']);
    putDirectory(fx.root, ['Media', 'Photos']);
    putFile(fx.root, 'loose.txt');
    putNestedFile(fx.root, ['Media', 'Photos'], 'pic.txt', 'x\n');
    putSymlink(fx.root, 'Shortcut', join(fx.root, 'Media')); // symlink dir: skipped
    putDirectory(fx.root, ['Remote']); // simulated other mount via injected stat seam
    putDirectory(fx.root, ['Locked']);
    chmodSync(join(fx.root, 'Locked'), 0o000); // unreadable subtree: skipped

    const fakeStat = (path: string): Promise<{ dev: number; ino: number }> => {
      if (path.endsWith('Remote')) return Promise.resolve({ dev: 999999, ino: 1 });
      return stat(path);
    };
    const source = new FilesystemSource({ clock: new FakeClock(), stat: fakeStat });
    const config = unwrap(await resolveRoot(fx.root));

    const destinations = unwrap(await source.discoverDirectories(config));
    const bySegments = new Map(destinations.map((d) => [d.segments.join('/'), d]));

    expect([...bySegments.keys()].sort()).toEqual(
      ['Documents', 'Documents/Work', 'Documents/Work/2026', 'Media', 'Media/Photos'].sort(),
    );
    for (const [key, dest] of bySegments) {
      const st = statStrings(join(fx.root, ...key.split('/')));
      expect(dest.device).toBe(st.device);
      expect(dest.inode).toBe(st.inode);
      expect(dest.status).toBe('observed');
      expect(dest.id).toMatch(/^dest-/);
    }
  });
});

describe('FilesystemSource.discover — root integrity', () => {
  it('reports a replaced root and an unreadable root without touching anything', async () => {
    const fx = makeFixtureRoot('rootguard');
    fixtures.push(fx);
    putFile(fx.root, 'a.txt', 'a\n');
    // Outside-root sentinel: the root subtree changes by design during this
    // test; the sentinel proves discovery touched nothing outside it.
    const outside = putDirectory(fx.parent, ['outside']);
    putFile(outside, 'sentinel.txt', 'outside bytes\n');
    const beforeOutside = treeFingerprint(outside);

    const source = new FilesystemSource({ clock: new FakeClock() });

    // Root replaced between resolution and discovery: identity mismatch.
    const config = unwrap(await resolveRoot(fx.root));
    rmSync(fx.root, { recursive: true });
    mkdirSync(fx.root);
    const replaced: Result<Item>[] = [];
    for await (const r of source.discover(config)) replaced.push(r);
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.ok).toBe(false);
    if (!replaced[0]?.ok) {
      expect(replaced[0]?.code).toBe('OUT_OF_SCOPE');
      expect(replaced[0]?.detail).toContain('root identity');
    }

    // Unreadable root: single explicit OUT_OF_SCOPE, no partial listing.
    chmodSync(fx.root, 0o000);
    const config2 = unwrap(await resolveRoot(fx.root));
    const denied: Result<Item>[] = [];
    for await (const r of source.discover(config2)) denied.push(r);
    expect(denied).toHaveLength(1);
    expect(denied[0]?.ok).toBe(false);
    if (!denied[0]?.ok) expect(denied[0]?.detail).toContain('permission');

    chmodSync(fx.root, 0o700);
    expect(treeFingerprint(outside)).toEqual(beforeOutside);
  });
});

describe('snapshot(fileHandle)', () => {
  it('hashes an opened file into a decimal-string snapshot', async () => {
    const fx = makeFixtureRoot('snapshot');
    fixtures.push(fx);
    putFile(fx.root, 'snap.txt', 'snap me\n');
    const handle = await open(join(fx.root, 'snap.txt'), 'r');
    try {
      const snap = unwrap(await snapshot(handle));
      expect(snap.sha256).toBe(sha256Hex('snap me\n'));
      const st = statStrings(join(fx.root, 'snap.txt'));
      expect(snap.inode).toBe(st.inode);
      expect(snap.mtimeNs).toBe(st.mtimeNs);
      expect(snap.ctimeNs).toBe(st.ctimeNs);
      expect(snap.size).toBe(st.size);
    } finally {
      await handle.close();
    }
  });

  it('refuses to hash beyond the 100 MiB eligibility ceiling', async () => {
    const fx = makeFixtureRoot('snap-big');
    fixtures.push(fx);
    putSparseFile(fx.root, 'huge.bin', 101 * 1024 * 1024);
    const handle = await open(join(fx.root, 'huge.bin'), 'r');
    try {
      const result = await snapshot(handle);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('OVERSIZE');
    } finally {
      await handle.close();
    }
  });
});
