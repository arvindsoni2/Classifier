import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ApprovedMove, Destination, RootConfig, Snapshot } from '../../src/domain/contracts.js';
import {
  inspectAt,
  mkdirAt,
  moveAt,
  probeFilesystem,
  undoAt,
} from '../../src/adapters/filesystem/helper.js';
import { FilesystemSource } from '../../src/adapters/filesystem/source.js';import {
  makeFixtureRoot,
  putDirectory,
  putFile,
  putHardLink,
  putSymlink,
  sha256Hex,
  statStrings,
  type FixtureRoot,
} from '../fixtures/files.js';

const HELPER =
  process.env.FSOPS_BINARY ??
  join(process.cwd(), 'native', 'fsops', 'target', 'release', 'fsops');

/** Ensures the release helper exists, building it via cargo when missing. */
function ensureHelperBinary(): string {
  if (existsSync(HELPER)) return HELPER;
  const result = spawnSync('cargo', ['build', '--release', '--manifest-path', 'native/fsops/Cargo.toml'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${join(homedir(), '.cargo', 'bin')}:${process.env.PATH ?? ''}`,
    },
    encoding: 'utf8',
    timeout: 600_000,
  });
  if (result.status !== 0 || !existsSync(HELPER)) {
    throw new Error(
      `helper binary could not be built (cargo status ${String(result.status)}); run \`pnpm test:native\` first and report the failure`,
    );
  }
  return HELPER;
}

const fixtures: FixtureRoot[] = [];
afterAll(() => {
  for (const fx of fixtures) fx.cleanup();
});

function fixture(label: string): FixtureRoot {
  const fx = makeFixtureRoot(label);
  fixtures.push(fx);
  return fx;
}

function config(fx: FixtureRoot): RootConfig {
  const st = statStrings(fx.root);
  return {
    rootId: `root-${sha256Hex(fx.root).slice(0, 40)}`,
    absolutePath: fx.root,
    device: st.device,
    inode: st.inode,
    inboxDepth: 0,
    directoryDepth: 3,
    policyRevision: 1,
  };
}

function destination(fx: FixtureRoot, segments: string[]): Destination {
  const st = statStrings(join(fx.root, ...segments));
  return {
    id: `dest-${sha256Hex(segments.join('/')).slice(0, 40)}`,
    segments,
    device: st.device,
    inode: st.inode,
    status: 'observed',
  };
}

function approvedMove(fx: FixtureRoot, basename: string, dest: Destination): ApprovedMove {
  const st = statSync(join(fx.root, basename), { bigint: true });
  const expected: Snapshot = {
    device: st.dev.toString(),
    inode: st.ino.toString(),
    size: st.size.toString(),
    mtimeNs: st.mtimeNs.toString(),
    ctimeNs: st.ctimeNs.toString(),
    sha256: createHash('sha256').update(readFileSync(join(fx.root, basename))).digest('hex'),
  };
  return {
    kind: 'move_file',
    actionId: 'action-1',
    rootId: 'root-1',
    sourceBasename: basename,
    destinationSegments: dest.segments,
    expected,
    approvalId: 'approval-1',
  };
}

describe('fsops helper bridge', () => {
  it('probes the kernel primitives and verifies the root identity', async () => {
    const binary = ensureHelperBinary();
    const fx = fixture('probe');
    const health = await probeFilesystem(config(fx), binary);
    expect(health.ok).toBe(true);
    if (health.ok) {
      expect(health.value.openat2).toBe(true);
      expect(health.value.renameat2Noreplace).toBe(true);
      expect(health.value.rootVerified).toBe(true);
      expect(health.value.kernel).toMatch(/^\d+\./);
    }

    // A replaced root (recorded identity no longer matches) is refused.
    const wrongConfig = { ...config(fx), inode: '000000000' };
    const denied = await probeFilesystem(wrongConfig, binary);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe('OUT_OF_SCOPE');
  });

  it('advertises the verified mutation capability only after the executor', () => {
    const source = new FilesystemSource();
    expect(source.capabilities()).toEqual({
      actions: ['move_file'],
      recovery: 'reconcile_and_reverse',
    });
  });

  it('inspects a file into a decimal-string snapshot', async () => {
    const binary = ensureHelperBinary();
    const fx = fixture('inspect');
    putFile(fx.root, 'report.txt', 'inspect me\n');
    const snapshot = await inspectAt(config(fx), ['report.txt'], binary);
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.sha256).toBe(sha256Hex('inspect me\n'));
      const st = statStrings(join(fx.root, 'report.txt'));
      expect(snapshot.value.inode).toBe(st.inode);
      expect(snapshot.value.mtimeNs).toBe(st.mtimeNs);
    }

    // Shell-like names are literal paths, resolved as data.
    putFile(fx.root, '$(touch marker).txt', 'shell\n');
    const shellSnap = await inspectAt(config(fx), ['$(touch marker).txt'], binary);
    expect(shellSnap.ok).toBe(true);
    expect(existsSync(join(fx.root, 'marker'))).toBe(false);
  });

  it('creates one directory segment and refuses placement through a symlink', async () => {
    const binary = ensureHelperBinary();
    const fx = fixture('mkdir');
    putDirectory(fx.root, ['Docs']);
    const created = await mkdirAt(config(fx), destination(fx, ['Docs']), 'Invoices', binary);
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.value.segments).toEqual(['Docs', 'Invoices']);
      expect(existsSync(join(fx.root, 'Docs', 'Invoices'))).toBe(true);
    }

    // A symlinked root-level directory cannot be traversed as a parent.
    putSymlink(fx.root, 'escape', fx.parent);
    const escapingParent: Destination = { ...destination(fx, ['Docs']), segments: ['escape'] };
    const escaping = await mkdirAt(config(fx), escapingParent, 'new-folder', binary);
    expect(escaping.ok).toBe(false);
    if (!escaping.ok) expect(escaping.code).toBe('OUT_OF_SCOPE');
    expect(existsSync(join(fx.root, 'Docs', 'escape'))).toBe(false);
    expect(existsSync(join(fx.parent, 'new-folder'))).toBe(false);
  });

  it('moves with RENAME_NOREPLACE, preserving basename, bytes and target', async () => {
    const binary = ensureHelperBinary();
    const fx = fixture('move');
    putDirectory(fx.root, ['Documents']);
    putFile(fx.root, 'invoice.txt', 'precious payload\n');
    const dest = destination(fx, ['Documents']);

    const receipt = await moveAt(approvedMove(fx, 'invoice.txt', dest), config(fx), dest, binary);
    expect(receipt.ok).toBe(true);
    if (receipt.ok) {
      expect(receipt.value.outcome).toBe('moved');
      expect(receipt.value.verified).toBe(true);
      expect(receipt.value.before.sha256).toBe(sha256Hex('precious payload\n'));
    }
    expect(readFileSync(join(fx.root, 'Documents', 'invoice.txt'), 'utf8')).toBe('precious payload\n');
    expect(existsSync(join(fx.root, 'invoice.txt'))).toBe(false);

    // A pre-existing target is retained unchanged; the source stays put.
    putFile(fx.root, 'invoice.txt', 'second invoice\n');
    const collision = await moveAt(approvedMove(fx, 'invoice.txt', dest), config(fx), dest, binary);
    expect(collision.ok).toBe(false);
    if (!collision.ok) expect(collision.code).toBe('COLLISION');
    expect(readFileSync(join(fx.root, 'Documents', 'invoice.txt'), 'utf8')).toBe('precious payload\n');
    expect(readFileSync(join(fx.root, 'invoice.txt'), 'utf8')).toBe('second invoice\n');
  });

  it('refuses multi-hardlink sources, symlinked destinations and stale pins', async () => {
    const binary = ensureHelperBinary();
    const fx = fixture('refusals');
    putDirectory(fx.root, ['Documents']);
    putFile(fx.root, 'single.txt', 'one link\n');
    putHardLink(fx.root, 'single.txt', 'linked.txt');
    putSymlink(fx.root, 'outlink', fx.parent);
    const dest = destination(fx, ['Documents']);

    const linked = await moveAt(approvedMove(fx, 'linked.txt', dest), config(fx), dest, binary);
    expect(linked.ok).toBe(false);
    if (!linked.ok) expect(linked.code).toBe('OUT_OF_SCOPE');

    // A symlink component cannot be traversed to reach a destination.
    const fakeDest: Destination = { ...dest, segments: ['outlink'], inode: '1' };
    const escaped = await moveAt(approvedMove(fx, 'single.txt', fakeDest), config(fx), fakeDest, binary);
    expect(escaped.ok).toBe(false);
    if (!escaped.ok) expect(escaped.code).toBe('OUT_OF_SCOPE');
    expect(existsSync(join(fx.parent, 'single.txt'))).toBe(false);

    // A stale destination pin is a deferred cross-mount, never a fallback.
    const staleDest: Destination = { ...dest, device: '999999', inode: '999998' };
    const stale = await moveAt(approvedMove(fx, 'single.txt', staleDest), config(fx), staleDest, binary);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('CROSS_MOUNT');
  });

  it('undoes a verified move back into a free original location', async () => {
    const binary = ensureHelperBinary();
    const fx = fixture('undo');
    putDirectory(fx.root, ['Documents']);
    putFile(fx.root, 'invoice.txt', 'round trip\n');
    const dest = destination(fx, ['Documents']);
    const moved = await moveAt(approvedMove(fx, 'invoice.txt', dest), config(fx), dest, binary);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;

    const after = moved.value.after;
    if (after === null || after === undefined) {
      throw new Error('the move receipt carried no post-move snapshot');
    }
    const undone = await undoAt(
      {
        actionId: 'action-1',
        approvalId: 'approval-2',
        basename: 'invoice.txt',
        targetSegments: ['Documents'],
        expected: after,
      },
      config(fx),
      binary,
    );
    expect(undone.ok).toBe(true);
    if (undone.ok) expect(undone.value.outcome).toBe('moved');
    expect(readFileSync(join(fx.root, 'invoice.txt'), 'utf8')).toBe('round trip\n');
    expect(existsSync(join(fx.root, 'Documents', 'invoice.txt'))).toBe(false);
  });

  it('defers a real cross-mount move (EXDEV) when a second mount sits under the root', () => {
    const binary = ensureHelperBinary();
    const fx = fixture('real-crossmount');
    putDirectory(fx.root, ['Remote']);
    putFile(fx.root, 'invoice.txt', 'do not cross\n');

    // A real second mount inside the root: the helper must refuse rather
    // than copy/delete across the boundary. Requires unprivileged user
    // namespaces; when unavailable the fixture is reported as blocked,
    // exactly as the plan specifies.
    const probe = spawnSync('unshare', ['--user', '--map-root-user', '--mount', 'true'], {
      encoding: 'utf8',
    });
    if (probe.error !== undefined || probe.status !== 0) {
      throw new Error(
        'cross-mount fixture BLOCKED: unprivileged mount namespaces are unavailable on this machine; ' +
          'the EXDEV path stays unverified and apply on real cross-mounts remains deferred',
      );
    }

    const rootSt = statSync(fx.root, { bigint: true });
    const config = {
      rootId: 'root-xmount',
      absolutePath: fx.root,
      device: rootSt.dev.toString(),
      inode: rootSt.ino.toString(),
      inboxDepth: 0,
      directoryDepth: 3,
      policyRevision: 1,
    } satisfies RootConfig;
    const request = JSON.stringify({
      verb: 'move',
      root: config,
      actionId: 'action-xmount',
      requestId: 'request-xmount',
      sourceBasename: 'invoice.txt',
      destination: { segments: ['Remote'], device: rootSt.dev.toString(), inode: rootSt.ino.toString() },
      expected: {
        device: rootSt.dev.toString(),
        inode: rootSt.ino.toString(),
        size: '10',
        mtimeNs: '0',
        ctimeNs: '0',
        sha256: '0',
      },
      approvalId: 'approval-1',
    });

    const moved = spawnSync(
      'unshare',
      [
        '--user',
        '--map-root-user',
        '--mount',
        'sh',
        '-c',
        `mount -t tmpfs none "$1/Remote" && printf %s "$2" | "$3"`,
        'sh',
        fx.root,
        request,
        binary,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    expect(moved.error).toBeUndefined();
    const response = JSON.parse(moved.stdout) as { ok: boolean; code?: string };
    expect(response.ok).toBe(false);
    expect(response.code).toBe('CROSS_MOUNT');
    expect(readFileSync(join(fx.root, 'invoice.txt'), 'utf8')).toBe('do not cross\n');
    expect(existsSync(join(fx.root, 'Remote', 'invoice.txt'))).toBe(false);
  });

  it('reports a clear failure when the helper binary is missing', async () => {
    const fx = fixture('missing-helper');
    const result = await probeFilesystem(config(fx), '/nonexistent/fsops-binary');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('UNSUPPORTED');
      expect(result.detail).toContain('cargo build');
    }
  });
});
