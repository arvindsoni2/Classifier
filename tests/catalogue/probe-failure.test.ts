/**
 * Task 7 item 6: a probe that fails is not an offline drive.
 *
 * `findmnt` can be missing, can hang, and can print something that is not its
 * JSON. All three used to be reported as "the path is not present", which is the
 * one answer that must never be invented: a root whose volume could not be read
 * is not a root that has gone away, and the difference decides whether the
 * catalogue retires forty thousand items or leaves them alone.
 *
 * The three cases are driven through an injected probe, so they run on a machine
 * with no drive attached and no `findmnt` to break on purpose. Each asserts the
 * same three things: the root is skipped, its items are untouched, and the reason
 * is on the record as `PROBE_FAILED` with the status the report will show.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatStats } from '../../src/catalogue/cli.js';
import { reportSummary } from '../../src/catalogue/report.js';
import type { CatalogueStore } from '../../src/catalogue/store.js';
import type { ScanResult } from '../../src/catalogue/scanner.js';
import {
  emptyMountPoint,
  itemsOf,
  rootRow,
  scanWorld,
  world,
  LAPTOP_FS,
} from './volume-world.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface ErrorRow {
  rel_path: string;
  code: string;
  message: string;
}

function errorsFor(store: CatalogueStore, scanId: number): ErrorRow[] {
  return store.db
    .prepare('SELECT rel_path, code, message FROM scan_errors WHERE scan_id = ? ORDER BY id')
    .all(scanId) as ErrorRow[];
}

/** The most recent scan's id, for assertions about "this run". */
function secondScanId(w: ReturnType<typeof world>): number {
  return (w.store.db.prepare('SELECT MAX(id) AS id FROM scans').get() as { id: number }).id;
}

/** Scans once with the drive present, then again with its probe failing. */
async function scanThenFail(
  label: string,
  fail: (w: ReturnType<typeof world>) => void,
): Promise<{ before: unknown[]; second: ScanResult; w: ReturnType<typeof world> }> {
  const w = world(label, { uuid: 'drive-uuid-p', label: 'MYDRIVE', fstype: 'exfat' }, cleanups);
  await scanWorld(w);
  const before = itemsOf(w.store, w.drive);
  expect(before.length).toBeGreaterThan(0);

  // Unplugged and the probe itself broken: the two are now indistinguishable to
  // the scanner, which is exactly why the distinction has to be carried in.
  emptyMountPoint(w);
  fail(w);
  const second = await scanWorld(w);
  return { before, second, w };
}

describe('a failed probe is not an offline drive (Task 7 item 6)', () => {
  it('findmnt missing: the root is skipped, its items untouched, and the reason recorded', async () => {
    const { before, second, w } = await scanThenFail('probe-missing', (world) => world.driveFails('findmnt: not found'));

    // Untouched: not retired, not marked missing, still holding their hashes.
    expect(itemsOf(w.store, w.drive)).toEqual(before);

    const errors = errorsFor(w.store, second.scanId);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('PROBE_FAILED');
    expect(errors[0]?.message).toMatch(/findmnt/);

    // The per-scan record says `probe_failed`, not `offline`. Ordered by path,
    // and `drive` sorts before `root`.
    const scanRoots = w.store.db
      .prepare('SELECT path, status FROM scan_roots WHERE scan_id = ? ORDER BY path')
      .all(second.scanId) as { path: string; status: string }[];
    expect(scanRoots).toEqual([
      { path: w.drive, status: 'probe_failed' },
      { path: w.root, status: 'online' },
    ]);
  });

  it('findmnt timing out is a probe failure, with the deadline in the message', async () => {
    const { before, second, w } = await scanThenFail('probe-timeout', (world) =>
      world.driveFails('findmnt: timed out after 5000ms'),
    );

    expect(itemsOf(w.store, w.drive)).toEqual(before);
    const errors = errorsFor(w.store, second.scanId);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('PROBE_FAILED');
    expect(errors[0]?.message).toMatch(/timed out/i);
  });

  it('unparsable output is a probe failure, not an absent path', async () => {
    const { before, second, w } = await scanThenFail('probe-unparsable', (world) =>
      world.driveFails('findmnt printed output that could not be read'),
    );

    expect(itemsOf(w.store, w.drive)).toEqual(before);
    const errors = errorsFor(w.store, second.scanId);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('PROBE_FAILED');
  });

  it('never marks the root offline, and keeps its volume facts', async () => {
    const { w } = await scanThenFail('probe-facts-kept', (world) => world.driveFails('findmnt: not found'));

    const root = rootRow(w.store, w.drive);
    // The difference from offline: the drive was never shown to be absent, so the
    // catalogue keeps saying the last thing it actually knows.
    expect(root.status).not.toBe('offline');
    expect(root.fstype).toBe('exfat');
    expect(root.volume_uuid).toBe('drive-uuid-p');
  });

  it('the report and stats show probe_failed with the drive’s last known count', async () => {
    const { before, second, w } = await scanThenFail('probe-report', (world) =>
      world.driveFails('findmnt: not found'),
    );

    const summary = reportSummary(w.store, second.scanId);
    const drive = summary.roots.find((root) => root.path === w.drive);
    expect(drive?.status).toBe('probe_failed');
    // The figures it would have had: an unreadable probe is not an empty drive.
    expect(drive?.files).toBe(before.length);
    expect(drive?.fstype).toBe('exfat');

    const stats = formatStats(summary);
    expect(stats).toContain('probe_failed');
    expect(stats).toContain(`${before.length} files`);
  });

  it('the laptop root is unaffected when only the drive probe fails', async () => {
    const { w } = await scanThenFail('probe-other-root', (world) => world.driveFails('findmnt: not found'));

    const statuses = w.store.db
      .prepare('SELECT path, status FROM scan_roots WHERE scan_id = ? ORDER BY path')
      .all(secondScanId(w)) as { path: string; status: string }[];
    expect(statuses).toEqual([
      { path: w.drive, status: 'probe_failed' },
      { path: w.root, status: 'online' },
    ]);
  });

  it('a probe that works again on the next scan restores the normal decision', async () => {
    // The failure is per-scan: nothing is latched, so a fixed machine recovers on
    // its next run without anyone editing the catalogue.
    const w = world('probe-recovers', { uuid: 'drive-uuid-r', label: 'MYDRIVE', fstype: 'exfat' }, cleanups);
    await scanWorld(w);

    emptyMountPoint(w);
    w.driveFails('findmnt: not found');
    const failed = await scanWorld(w);
    expect(
      (w.store.db
        .prepare('SELECT status FROM scan_roots WHERE scan_id = ? AND path = ?')
        .get(failed.scanId, w.drive) as { status: string }).status,
    ).toBe('probe_failed');

    // Drive back, mount point back, probe answering again.
    w.driveIs({ ...LAPTOP_FS, mountPoint: w.drive });
    const recovered = await scanWorld(w);
    expect(
      (w.store.db
        .prepare('SELECT status FROM scan_roots WHERE scan_id = ? AND path = ?')
        .get(recovered.scanId, w.drive) as { status: string }).status,
    ).toBe('online');
  });
});